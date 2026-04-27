"""
Runtime context for SCXML state machines.

Manages event queues, delayed sends, and invoked children.
"""

from __future__ import annotations
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable, TYPE_CHECKING
import threading
import time

if TYPE_CHECKING:
    from scxmlgen.event import Event
    from scxmlgen.datamodel.interface import IDataModel


@dataclass
class InvokedChild:
    """Represents an invoked child state machine."""
    invoke_id: str
    child: Any  # IScxmlStateMachine - avoid circular import
    autoforward: bool = False
    finalize_actions: list[Callable[[RuntimeContext, Event], None]] = field(default_factory=list)

    @property
    def is_finished(self) -> bool:
        return self.child.is_finished if hasattr(self.child, 'is_finished') else True

    def forward_event(self, event: Event) -> None:
        """Forward an event to the child.

        Note: We clear invokeid when forwarding because the child has a different
        invoked children context. If we don't clear it, the child would try to
        look up the invokeid in its own context and incorrectly discard the event.
        """
        if hasattr(self.child, 'send'):
            # Create a copy of the event without invokeid for forwarding
            from scxmlgen.event import Event as EventClass
            forwarded_event = EventClass(
                name=event.name,
                type=event.type,
                sendid=event.sendid,
                origin=event.origin,
                origintype=event.origintype,
                invokeid=None,  # Clear invokeid for forwarding
                data=event.data,
                raw_data=event.raw_data
            )
            self.child.send(forwarded_event)


class RuntimeContext:
    """
    Runtime context for SCXML state machine execution.

    Manages:
    - Internal and external event queues
    - Delayed send scheduling
    - Invoked child state machines
    - Current event reference
    """

    def __init__(self, session_id: str, data_model: IDataModel) -> None:
        self.session_id = session_id
        self.data_model = data_model
        self.logger: Callable[[str], None] = lambda msg: None

        # Origin URI for this session (used in _event.origin)
        self.origin_uri = f"#_scxml_{session_id}"

        # Counter for auto-generated send IDs
        self._send_counter = 0

        # Event queues (internal has priority over external)
        self._internal_queue: deque[Event] = deque()
        self._external_queue: deque[Event] = deque()

        # Delayed sends — timer-based, not polled
        self._lock = threading.Lock()
        self._wakeup_listener: Callable[[], None] | None = None
        self._pending_timers: dict[str, tuple[threading.Timer, float]] = {}
        #                          send_id → (timer, due_time_unix)

        # Invoked children
        self._invoked_children: dict[str, InvokedChild] = {}
        self._pending_invokes: list[Callable[[], None]] = []

        # Current event being processed
        self._current_event: Event | None = None

    def generate_send_id(self) -> str:
        """Generates a unique send ID."""
        self._send_counter += 1
        return f"send.{self.session_id}.{self._send_counter}"

    @property
    def current_event(self) -> Event | None:
        """Gets the current event being processed."""
        return self._current_event

    def set_current_event(self, event: Event | None) -> None:
        """Sets the current event and updates the data model."""
        self._current_event = event
        self.data_model.set_current_event(event)

    def enqueue_internal(self, event: Event) -> None:
        """Adds an event to the internal queue (higher priority)."""
        self._internal_queue.append(event)

    def enqueue_external(self, event: Event) -> None:
        """Adds an event to the external queue."""
        self._external_queue.append(event)

    def has_internal_events(self) -> bool:
        """Whether internal event queue has pending events."""
        return len(self._internal_queue) > 0

    def has_external_events(self) -> bool:
        """Whether external event queue has pending events."""
        return len(self._external_queue) > 0

    def has_active_invokes(self) -> bool:
        """Whether any invoked child sessions are active."""
        return len(getattr(self, '_invoked_children', {})) > 0

    def dequeue_internal(self) -> Event | None:
        """Dequeues the next internal event."""
        return self._internal_queue.popleft() if self._internal_queue else None

    def set_wakeup_listener(self, listener: Callable[[], None] | None) -> None:
        """Registers (or clears) the wakeup listener called when a delayed send fires."""
        with self._lock:
            self._wakeup_listener = listener

    def dequeue_event(self) -> Event | None:
        """
        Dequeues the next event to process.

        Internal events have priority over external events.
        Delayed sends are delivered directly by their threading.Timer callbacks.
        """
        # Internal queue has priority
        if self._internal_queue:
            return self._internal_queue.popleft()

        # Then external queue
        if self._external_queue:
            return self._external_queue.popleft()

        return None

    def schedule_delayed_send(
        self,
        event: Event,
        delay_ms: int,
        send_id: str | None = None,
        target: str | None = None
    ) -> str:
        """
        Schedules a delayed send using a threading.Timer.

        Args:
            event: The event to send.
            delay_ms: Delay in milliseconds.
            send_id: Optional send ID (auto-generated if not provided).
            target: Optional target for the send.

        Returns:
            The send ID.
        """
        if send_id is None:
            send_id = self.generate_send_id()

        delay_s = delay_ms / 1000.0
        due_time = time.time() + delay_s
        _send_id = send_id  # capture for closure

        def _fire() -> None:
            with self._lock:
                self._pending_timers.pop(_send_id, None)
                listener = self._wakeup_listener
            # deque.append is GIL-safe — no lock needed here
            self._external_queue.append(event)
            if listener:
                listener()

        timer = threading.Timer(delay_s, _fire)
        timer.daemon = True
        with self._lock:
            self._pending_timers[send_id] = (timer, due_time)
        timer.start()
        return send_id

    def cancel_delayed_send(self, send_id: str) -> bool:
        """
        Cancels a delayed send.

        Args:
            send_id: The send ID to cancel.

        Returns:
            True if the send was cancelled, False if not found.
        """
        with self._lock:
            entry = self._pending_timers.pop(send_id, None)
        if entry:
            entry[0].cancel()
            return True
        return False

    def has_pending_delayed_sends(self) -> bool:
        """Checks if there are any pending delayed sends."""
        with self._lock:
            return len(self._pending_timers) > 0

    def get_next_delayed_send_time(self) -> float | None:
        """Gets the time of the next delayed send (Unix timestamp), or None."""
        with self._lock:
            if not self._pending_timers:
                return None
            return min(due for _, due in self._pending_timers.values())

    # Invoke management

    def register_pending_invoke(self, start_fn: Callable[[], None]) -> None:
        """Registers an invoke to be started at the end of the macrostep."""
        self._pending_invokes.append(start_fn)

    def start_pending_invokes(self) -> None:
        """Starts all pending invokes (called at end of macrostep)."""
        while self._pending_invokes:
            start_fn = self._pending_invokes.pop(0)
            try:
                start_fn()
            except Exception as e:
                self.logger(f"Error starting invoke: {e}")

    def register_invoked_child(
        self,
        invoke_id: str,
        child: Any,
        autoforward: bool = False,
        finalize_actions: list[Callable[[RuntimeContext, Event], None]] | None = None
    ) -> None:
        """
        Registers an invoked child state machine.

        Args:
            invoke_id: The invoke ID.
            child: The child state machine.
            autoforward: Whether to auto-forward events.
            finalize_actions: List of finalize action callbacks.
        """
        self._invoked_children[invoke_id] = InvokedChild(
            invoke_id=invoke_id,
            child=child,
            autoforward=autoforward,
            finalize_actions=finalize_actions or []
        )

    def get_invoked_child(self, invoke_id: str) -> InvokedChild | None:
        """Gets an invoked child by ID."""
        return self._invoked_children.get(invoke_id)

    def cancel_invoke(self, invoke_id: str) -> None:
        """Cancels an invoked child."""
        if invoke_id in self._invoked_children:
            del self._invoked_children[invoke_id]

    def cancel_all_invokes(self) -> None:
        """Cancels all invoked children."""
        self._invoked_children.clear()

    def get_all_active_children(self) -> list[InvokedChild]:
        """Gets all active invoked children."""
        return list(self._invoked_children.values())

    def get_auto_forward_children(self) -> list[InvokedChild]:
        """Gets all children with autoforward enabled."""
        return [c for c in self._invoked_children.values() if c.autoforward]

    # Error handling

    def raise_error_execution(self, message: str) -> None:
        """Raises an error.execution event."""
        from scxmlgen.event import Event
        error_event = Event.platform("error.execution")
        # Note: Could add message as data in future
        self._internal_queue.append(error_event)
        self.logger(f"error.execution: {message}")

    def raise_error_communication(self, message: str) -> None:
        """Raises an error.communication event."""
        from scxmlgen.event import Event
        error_event = Event.platform("error.communication")
        self._internal_queue.append(error_event)
        self.logger(f"error.communication: {message}")
