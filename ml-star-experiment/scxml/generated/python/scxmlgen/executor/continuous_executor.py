"""
Continuous executor for SCXML state machines.

Provides thread-safe execution with automatic event pumping.
"""

from __future__ import annotations
import queue
import threading
import time
from concurrent.futures import Future
from dataclasses import dataclass
from enum import Enum, auto
from typing import Any, Callable, TYPE_CHECKING

if TYPE_CHECKING:
    from scxmlgen.transpiled_state_machine import TranspiledStateMachine
    from scxmlgen.event import Event


class CommandType(Enum):
    """Types of commands that can be sent to the executor."""
    EVENT = auto()
    WAKE = auto()      # timer fired; drain pending events from external queue
    SHUTDOWN = auto()


@dataclass
class Command:
    """A command to be processed by the executor."""
    cmd_type: CommandType
    event: "Event | None" = None
    future: "Future[None] | None" = None


class ContinuousExecutor:
    """
    Executor that keeps a state machine running on a dedicated thread.

    Continuously drains external and scheduled events. External callers can
    submit events synchronously or asynchronously and receive completion
    signals via Futures.

    Example usage::

        from scxmlgen.executor import ContinuousExecutor
        from my_machine import MyStateMachine

        machine = MyStateMachine()
        executor = ContinuousExecutor(machine)

        # Start the machine (non-blocking)
        executor.start()

        # Send events (thread-safe)
        executor.send("button_pressed")
        future = executor.send_async("timer_expired")
        future.result()  # Wait for completion

        # Shutdown
        executor.shutdown()

    Thread Safety:
        All public methods are thread-safe. Events can be fired from any thread.
    """

    def __init__(self, machine: "TranspiledStateMachine") -> None:
        """
        Creates a new continuous executor.

        Args:
            machine: The state machine to execute.
        """
        self._machine = machine
        self._command_queue: queue.Queue[Command] = queue.Queue()
        self._started = False
        self._running = False
        self._shutdown = False
        self._disposed = False
        self._worker_thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._completion_event = threading.Event()
        self._state_change_callback: Any = None

    @property
    def state_machine(self) -> "TranspiledStateMachine":
        """Gets the underlying state machine."""
        return self._machine

    @property
    def is_running(self) -> bool:
        """Returns True if the executor is running."""
        return self._running and not self._shutdown

    def start(self, init_data: dict[str, Any] | None = None) -> None:
        """
        Starts the state machine and begins processing events.

        The machine is started synchronously on the calling thread so that
        the initial configuration is fully entered before this method returns.
        Only the event-processing worker loop runs on a background thread.

        Args:
            init_data: Optional initial data to pass to the machine.
        """
        with self._lock:
            if self._started:
                raise RuntimeError("Executor already started")
            if self._disposed:
                raise RuntimeError("Executor has been disposed")

            # Start the machine synchronously (same pattern as Java executor)
            if init_data:
                self._machine.start(init_data)
            else:
                self._machine.start()

            self._started = True
            self._running = True
            self._worker_thread = threading.Thread(
                target=self._worker_loop,
                daemon=True,
                name=f"scxml-executor-{self._machine._name}"
            )
            self._worker_thread.start()

    def send(self, event_or_name: "Event | str", data: dict[str, Any] | None = None) -> None:
        """
        Sends an event and waits for it to be processed (synchronous).

        Args:
            event_or_name: Event object or event name string.
            data: Optional event data (only used if event_or_name is a string).
        """
        future = self.send_async(event_or_name, data)
        future.result()

    def send_async(self, event_or_name: "Event | str", data: dict[str, Any] | None = None) -> "Future[None]":
        """
        Fires an event asynchronously.

        Args:
            event_or_name: Event object or event name string.
            data: Optional event data (only used if event_or_name is a string).

        Returns:
            A Future that completes when the event has been processed.
        """
        from scxmlgen.event import Event

        self._ensure_operational()

        if isinstance(event_or_name, str):
            builder = Event.builder().name(event_or_name).type("external")
            if data:
                builder.data(data)
            event = builder.build()
        else:
            event = event_or_name

        future: Future[None] = Future()
        command = Command(
            cmd_type=CommandType.EVENT,
            event=event,
            future=future
        )
        self._command_queue.put(command)
        return future

    def send_by_id(self, event_id: int, data: dict[str, Any] | None = None) -> None:
        """
        Sends an event by integer ID (O(1) dispatch). Blocks until processed.

        The machine must define a ``get_event_name(event_id)`` method (generated automatically).
        """
        name = self._machine.get_event_name(event_id)
        self.send(name, data)

    def send_by_id_async(self, event_id: int, data: dict[str, Any] | None = None) -> "Future[None]":
        """
        Sends an event by integer ID asynchronously. Returns a Future.
        """
        name = self._machine.get_event_name(event_id)
        return self.send_async(name, data)

    def pump_events(self) -> None:
        """
        Processes pending events on the current thread.

        This is useful for testing or when you want manual control
        over event processing.
        """
        self._ensure_operational()
        self._machine.pump_events()

    def wait_for_completion(self, timeout: float | None = None) -> bool:
        """
        Blocks until the state machine reaches a final state or timeout expires.

        Args:
            timeout: Maximum seconds to wait (None for indefinite).

        Returns:
            True if machine finished, False on timeout.
        """
        return self._completion_event.wait(timeout)

    def on_state_change(self, callback: Any) -> Any:
        """
        Registers a listener called after each macrostep with entered/exited state names.

        Args:
            callback: Function(entered: list[str], exited: list[str])

        Returns:
            An unsubscribe callable.
        """
        self._state_change_callback = callback
        return lambda: setattr(self, '_state_change_callback', None)

    def stop(self, timeout: float | None = 5.0) -> None:
        """
        Gracefully stops the executor.

        Args:
            timeout: Maximum time to wait for shutdown (None for indefinite).
        """
        with self._lock:
            if self._shutdown or self._disposed:
                return
            self._shutdown = True

        # Send shutdown command
        self._command_queue.put(Command(cmd_type=CommandType.SHUTDOWN))

        # Wait for worker thread
        if self._worker_thread is not None:
            self._worker_thread.join(timeout)
            if self._worker_thread.is_alive():
                # Thread didn't stop in time - force mark as disposed
                pass

        with self._lock:
            self._running = False
            self._disposed = True

    def shutdown(self, timeout: float | None = 5.0) -> None:
        """Deprecated: use stop() instead."""
        import warnings
        warnings.warn("shutdown() is deprecated, use stop() instead", DeprecationWarning, stacklevel=2)
        self.stop(timeout)

    def __enter__(self) -> "ContinuousExecutor":
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        self.stop()

    def _ensure_operational(self) -> None:
        """Raises an error if the executor is not operational."""
        if self._disposed:
            raise RuntimeError("Executor has been disposed")
        if not self._started:
            raise RuntimeError("Executor has not been started")
        if self._shutdown:
            raise RuntimeError("Executor is shutting down")

    def _worker_loop(self) -> None:
        """Main worker loop that processes commands and events."""
        rc = None
        try:
            # Register wakeup listener so timer callbacks wake this thread
            rc = getattr(self._machine, '_runtime_context', None)
            if rc is not None:
                def _wakeup() -> None:
                    try:
                        self._command_queue.put_nowait(Command(CommandType.WAKE))
                    except Exception:
                        pass
                rc.set_wakeup_listener(_wakeup)

            while not self._shutdown:
                # Block indefinitely — woken by explicit commands or timer WAKE
                command = self._command_queue.get()

                if command.cmd_type == CommandType.SHUTDOWN:
                    break
                elif command.cmd_type == CommandType.WAKE:
                    before = self._snapshot_states()
                    self._machine.pump_events()
                    self._notify_state_change(before)
                    self._check_completion()
                elif command.cmd_type == CommandType.EVENT and command.event is not None:
                    try:
                        before = self._snapshot_states()
                        self._machine.send(command.event)
                        self._machine.pump_events()
                        self._notify_state_change(before)
                        self._check_completion()
                        if command.future:
                            command.future.set_result(None)
                    except Exception as e:
                        if command.future:
                            command.future.set_exception(e)
                        else:
                            raise

        except Exception as e:
            # Log error but don't crash
            import sys
            print(f"Executor error: {e}", file=sys.stderr)
        finally:
            # Deregister listener so no late callbacks fire after the loop exits
            if rc is not None:
                rc.set_wakeup_listener(None)
            with self._lock:
                self._running = False


    def _snapshot_states(self) -> set[int]:
        """Take a snapshot of current active states."""
        return set(self._machine._active_states) if self._state_change_callback else set()

    def _notify_state_change(self, before: set[int]) -> None:
        """Fire state change callback if states changed."""
        cb = self._state_change_callback
        if cb is None:
            return
        after = set(self._machine._active_states)
        entered_idx = after - before
        exited_idx = before - after
        if not entered_idx and not exited_idx:
            return
        entered = [self._machine._get_state_name(i) for i in entered_idx if self._machine._get_state_name(i)]
        exited = [self._machine._get_state_name(i) for i in exited_idx if self._machine._get_state_name(i)]
        try:
            cb(entered, exited)
        except Exception:
            pass  # Don't let listener crash the executor

    def _check_completion(self) -> None:
        """Signal completion if machine reached a final state."""
        if self._machine._finished:
            self._completion_event.set()


class RunToCompletionExecutor:
    """
    Simple executor that processes events to completion.

    Unlike ContinuousExecutor, this runs on the calling thread and
    doesn't handle delayed sends automatically.

    Example usage::

        executor = RunToCompletionExecutor(machine)
        executor.start()
        executor.send("go")
        executor.send("stop")
    """

    def __init__(self, machine: "TranspiledStateMachine") -> None:
        self._machine = machine
        self._started = False

    @property
    def state_machine(self) -> "TranspiledStateMachine":
        """Gets the underlying state machine."""
        return self._machine

    def start(self, init_data: dict[str, Any] | None = None) -> None:
        """Starts the state machine."""
        if self._started:
            raise RuntimeError("Already started")
        self._started = True
        if init_data:
            self._machine.start(init_data)
        else:
            self._machine.start()

    def send(self, event_or_name: "Event | str", data: dict[str, Any] | None = None) -> None:
        """Sends an event and processes it to completion."""
        from scxmlgen.event import Event

        if not self._started:
            raise RuntimeError("Not started")

        if isinstance(event_or_name, str):
            builder = Event.builder().name(event_or_name).type("external")
            if data:
                builder.data(data)
            event = builder.build()
        else:
            event = event_or_name

        self._machine.send(event)
        self._machine.pump_events()
