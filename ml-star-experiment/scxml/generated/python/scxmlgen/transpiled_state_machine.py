"""
Base class for transpiled SCXML state machines.

Generated Python state machines extend this class to inherit common functionality.
"""

from __future__ import annotations
from abc import ABC, abstractmethod
from typing import Any, Callable, TYPE_CHECKING
import uuid
import re

from scxmlgen.event import Event
from scxmlgen.runtime_context import RuntimeContext
from scxmlgen.datamodel.interface import DataModelType, IDataModel
from scxmlgen.datamodel.null_datamodel import NullDataModel

if TYPE_CHECKING:
    from scxmlgen.trace.trace_listener import ITraceListener


class TranspiledStateMachine(ABC):
    """
    Base class for transpiled SCXML state machines.

    Generated state machines extend this class to inherit common functionality
    including event processing, state management, and data model access.
    """

    def __init__(self, name: str, data_model_type: DataModelType, state_count: int) -> None:
        """
        Creates a new transpiled state machine.

        Args:
            name: State machine name.
            data_model_type: Data model type.
            state_count: Total number of states.
        """
        self._name = name
        self._data_model_type = data_model_type
        self._state_count = state_count

        # State tracking using a set for O(1) lookups
        self._active_states: set[int] = set()

        # Transient states fired during current microstep (for parallel conflict resolution)
        self._transient_fired_states: set[int] = set()

        # Runtime state
        self._session_id: str = ""
        self._started: bool = False
        self._finished: bool = False

        # Components (initialized on start)
        self._data_model: IDataModel = None  # type: ignore
        self._runtime_context: RuntimeContext = None  # type: ignore

        # Callbacks and listeners
        self._parent_callback: Callable[[Event], None] | None = None
        self._trace_listener: ITraceListener | None = None
        self._logger: Callable[[str], None] = lambda msg: None

    @property
    def name(self) -> str:
        """State machine name from SCXML."""
        return self._name

    @property
    def session_id(self) -> str:
        """Session ID for this instance."""
        return self._session_id

    @property
    def data_model_type(self) -> DataModelType:
        """Data model type."""
        return self._data_model_type

    @property
    def is_finished(self) -> bool:
        """Whether state machine has finished."""
        return self._finished

    @property
    def is_started(self) -> bool:
        """Whether state machine has started."""
        return self._started

    @property
    def active_states(self) -> frozenset[str]:
        """Gets all currently active state IDs."""
        return frozenset(
            name for i in self._active_states
            if (name := self._get_state_name(i)) is not None
        )

    @property
    def final_states(self) -> frozenset[str]:
        """Gets the final states (valid after is_finished is True)."""
        return self.active_states

    def start(self, init_data: dict[str, Any] | None = None) -> None:
        """
        Starts the state machine.

        Args:
            init_data: Optional initialization data (for invoked children).
                      Per W3C spec, init data overrides data element defaults.
        """
        if self._started:
            return
        self._started = True

        self._session_id = str(uuid.uuid4())

        # Create data model based on type
        self._data_model = self._create_data_model()

        # Create runtime context
        self._runtime_context = RuntimeContext(self._session_id, self._data_model)
        self._runtime_context.logger = self._logger

        # Initialize system variables
        self._data_model.initialize_system_variables(self._session_id, self._name)

        # Configure data model (initialize variables with defaults)
        self._configure_data_model()

        # Apply init data from parent's <param> elements (overrides defaults)
        if init_data:
            for key, value in init_data.items():
                if self._data_model.has(key):
                    self._data_model.set(key, value)

        # Trace session start
        if self._trace_listener:
            import time
            dm_name = {
                DataModelType.ECMASCRIPT: "ecmascript",
                DataModelType.NATIVE_PYTHON: "native-python",
            }.get(self._data_model_type, "null")
            self._trace_listener.on_session_start(
                self._session_id, self._name, dm_name,
                int(time.time() * 1_000_000)
            )

        # Enter initial state
        self._enter_initial_state()

        # Process eventless transitions
        self._check_eventless_transitions()

        # Run to completion
        self._run_to_completion()

    def _create_data_model(self) -> IDataModel:
        """Creates the appropriate data model based on type."""
        match self._data_model_type:
            case DataModelType.ECMASCRIPT:
                from scxmlgen.datamodel.ecmascript_datamodel import ECMAScriptDataModel
                return ECMAScriptDataModel(self.is_in_state)
            case DataModelType.NULL:
                return NullDataModel(self.is_in_state)
            case DataModelType.NATIVE_PYTHON:
                # Native uses null datamodel for In() but fields on the class
                return NullDataModel(self.is_in_state)
            case _:
                return NullDataModel(self.is_in_state)

    def send(self, event_or_name: Event | str, data: dict[str, Any] | None = None) -> None:
        """
        Sends an event to the state machine.

        Args:
            event_or_name: Event object or event name string.
            data: Optional event data (only used if event_or_name is a string).
        """
        if self._finished:
            return

        if isinstance(event_or_name, str):
            if data:
                event = Event.builder().name(event_or_name).data(data).build()
            else:
                event = Event.named(event_or_name)
        else:
            event = event_or_name

        # Fast path: bypass queue when no delayed/invoke/internal events pending
        rc = self._runtime_context
        if (not rc.has_external_events()
                and not rc.has_active_invokes()
                and not rc.has_internal_events()):
            rc.set_current_event(event)
            event_id = self._get_event_id(event.name)
            self._dispatch_event(event_id, event)
            # Short-circuit: skip eventless check if machine has none
            if getattr(self, '_HAS_EVENTLESS_TRANSITIONS', True) or rc.has_internal_events():
                self._check_eventless_transitions()
                while rc.has_internal_events():
                    internal = rc.dequeue_internal()
                    if internal is None:
                        break
                    rc.set_current_event(internal)
                    iid = self._get_event_id(internal.name)
                    self._dispatch_event(iid, internal)
                    self._check_eventless_transitions()
            rc.set_current_event(None)
            rc.start_pending_invokes()
            return

        # Slow path: full W3C queue processing
        rc.enqueue_external(event)
        self._run_to_completion()

    def send_by_id(self, event_id: int, data: dict[str, Any] | None = None) -> None:
        """
        Sends an event by its integer ID for optimized O(1) dispatch.

        Use this with the generated EVT_* constants for maximum performance.

        Args:
            event_id: The event ID (use EVT_* constants from generated code).
            data: Optional event data.
        """
        event_name = self._get_event_name_by_id(event_id)
        if event_name is None:
            self._logger(f"send_by_id: Unknown event ID {event_id}")
            return
        self.send(event_name, data)

    def get_event_name(self, event_id: int) -> str:
        """
        Gets the event name for an integer event ID.

        Override in generated code to provide the mapping.
        Raises ValueError if the ID is unknown.
        """
        name = self._get_event_name_by_id(event_id)
        if name is None:
            raise ValueError(f"Unknown event ID: {event_id}")
        return name

    def _get_event_name_by_id(self, event_id: int) -> str | None:
        """
        Gets the event name for an event ID.

        Override in generated code to provide the mapping.
        """
        return None

    def pump_events(self) -> None:
        """
        Pumps any pending events and processes them.

        Call this periodically when waiting for delayed events.
        Also pumps events for all active invoked children.
        """
        if self._finished:
            return

        # Pump events for all active children first
        for child_info in self._runtime_context.get_all_active_children():
            if not child_info.is_finished:
                if hasattr(child_info.child, 'pump_events'):
                    child_info.child.pump_events()

        self._run_to_completion()

    def is_in_state(self, state_id: str) -> bool:
        """Checks if a state is currently active."""
        index = self._get_state_index(state_id)
        return index >= 0 and index in self._active_states

    def get_all_events(self) -> frozenset:
        """Returns all events this state machine can react to."""
        return frozenset()

    def get_enabled_events(self) -> frozenset:
        """Returns events currently enabled based on active states and guard conditions."""
        return frozenset()

    def get_events_for_state(self, state_id: str) -> frozenset:
        """Returns all events a specific state can react to (including ancestor transitions)."""
        return frozenset()

    def get_enabled_events_for_state(self, state_id: str) -> frozenset:
        """Returns events currently enabled for a specific active state (guard-aware)."""
        return frozenset()

    def get_variable(self, name: str) -> Any:
        """Gets a data model variable."""
        return self._data_model.get(name)

    def set_variable(self, name: str, value: Any) -> None:
        """Sets a data model variable."""
        self._data_model.set(name, value)

    def set_trace_listener(self, listener: ITraceListener | None) -> None:
        """Sets the trace listener for debugging."""
        self._trace_listener = listener

    def set_logger(self, logger: Callable[[str], None]) -> None:
        """Sets the logger function."""
        self._logger = logger
        if self._runtime_context:
            self._runtime_context.logger = logger

    def set_parent_callback(self, callback: Callable[[Event], None] | None) -> None:
        """Sets the callback for sending events to parent state machine."""
        self._parent_callback = callback

    # Protected methods for generated code

    def _run_to_completion(self) -> None:
        """Runs the event loop to completion."""
        while not self._finished:
            event = self._runtime_context.dequeue_event()
            if event is None:
                # End of macrostep - start any pending invokes
                self._runtime_context.start_pending_invokes()
                break

            self._process_event(event)

    def _process_event(self, event: Event) -> None:
        """Processes a single event."""
        # Call finalize actions if this event is from an invoked child
        if event.invokeid:
            child_info = self._runtime_context.get_invoked_child(event.invokeid)
            if child_info:
                for finalize_action in child_info.finalize_actions:
                    try:
                        finalize_action(self._runtime_context, event)
                    except Exception as ex:
                        self._logger(f"Finalize action error: {ex}")
            else:
                # W3C test252: Events from cancelled invokes must be discarded
                # EXCEPT for done.invoke events (W3C test236) which should still be delivered
                if not event.name.startswith("done.invoke"):
                    self._logger(f"Discarding event '{event.name}' from cancelled invoke '{event.invokeid}'")
                    return

        # Per W3C spec: Forward external events to children with autoforward=true
        if event.type == "external":
            for child in self._runtime_context.get_auto_forward_children():
                try:
                    child.forward_event(event)
                except Exception as ex:
                    self._logger(f"Error forwarding event to child {child.invoke_id}: {ex}")

        self._runtime_context.set_current_event(event)

        if self._trace_listener:
            import time
            self._trace_listener.on_event_received(event, int(time.time() * 1_000_000))

        # Get event ID for fast dispatch
        event_id = self._get_event_id(event.name)

        # Dispatch to active states
        self._dispatch_event(event_id, event)

        # Check eventless transitions
        self._check_eventless_transitions()

        if self._trace_listener:
            import time
            self._trace_listener.on_event_processed(event, int(time.time() * 1_000_000))

        self._runtime_context.set_current_event(None)

    def _send_to_parent(self, event: Event) -> None:
        """Sends an event to the parent state machine (for invoked children)."""
        if self._parent_callback:
            self._parent_callback(event)

    def _finish(self) -> None:
        """Marks the state machine as finished and cleans up."""
        self._finished = True
        self._runtime_context.cancel_all_invokes()

        if self._trace_listener:
            import time
            self._trace_listener.on_session_end(
                self._session_id,
                self.active_states,
                int(time.time() * 1_000_000)  # microseconds
            )

        # Notify parent that this invoked child has finished
        if self._parent_callback:
            done_event = Event.builder() \
                .name("done.invoke") \
                .type("platform") \
                .build()
            self._parent_callback(done_event)

    def _raise_internal(self, event_name: str, data: dict[str, Any] | None = None) -> None:
        """Raises an internal event."""
        if data:
            event = Event.builder().name(event_name).type("internal").data(data).build()
        else:
            event = Event(name=event_name, type="internal")
        self._runtime_context.enqueue_internal(event)

    def _raise_internal_with_data(self, event_name: str, data: dict[str, Any]) -> None:
        """Raises an internal event with data dict (for donedata with params)."""
        event = Event.builder().name(event_name).type("internal").data(data).build()
        self._runtime_context.enqueue_internal(event)

    def _raise_internal_with_raw_data(self, event_name: str, raw_data: Any) -> None:
        """Raises an internal event with raw data (for donedata with content)."""
        event = Event.builder().name(event_name).type("internal").raw_data(raw_data).build()
        self._runtime_context.enqueue_internal(event)

    def _raise_platform(self, event_name: str, sendid: str | None = None) -> None:
        """Raises a platform event, optionally with a sendid for send error tracking."""
        event = Event.builder().name(event_name).type("platform")
        if sendid:
            event = event.sendid(sendid)
        self._runtime_context.enqueue_internal(event.build())

    @staticmethod
    def _parse_delay(delay: str) -> int:
        """
        Parses a delay string (e.g., "1s", "500ms", "0.5s") to milliseconds.
        """
        if not delay:
            return 0

        delay = delay.strip().lower()

        if delay.endswith("ms"):
            try:
                return int(delay[:-2])
            except ValueError:
                return 0
        elif delay.endswith("s"):
            try:
                return int(float(delay[:-1]) * 1000)
            except ValueError:
                return 0
        elif delay.endswith("m"):
            try:
                return int(float(delay[:-1]) * 60 * 1000)
            except ValueError:
                return 0
        else:
            # Assume milliseconds
            try:
                return int(delay)
            except ValueError:
                return 0

    def _generate_send_id(self) -> str:
        """Generates a unique send ID."""
        return f"send.{self._session_id}.{uuid.uuid4().hex}"

    def _matches_event_descriptor(self, event_name: str | None, descriptor: str) -> bool:
        """
        Checks if an event name matches an event descriptor.

        Per W3C spec, an event matches if it equals the descriptor or
        starts with the descriptor followed by a dot.
        """
        if event_name is None:
            return False
        if event_name == descriptor:
            return True
        return event_name.startswith(descriptor + ".")

    def _register_pending_invoke(self, invoke_id: str, options: dict[str, Any]) -> None:
        """
        Registers an invoke to be started at the end of the macrostep.

        Args:
            invoke_id: The invoke ID.
            options: Dict with type, child_class/src/content, autoforward, data, etc.
        """
        def start_invoke() -> None:
            self._start_invoke(invoke_id, options)

        self._runtime_context.register_pending_invoke(start_invoke)

    def _start_invoke(self, invoke_id: str, options: dict[str, Any]) -> None:
        """
        Actually starts an invoked child state machine.

        Args:
            invoke_id: The invoke ID.
            options: Dict with type, child_class/src/content, autoforward, data, etc.
        """
        # W3C test252: Check if parent state is still active before starting
        # The invoke could have been cancelled if the state was exited before macrostep ended
        parent_state = options.get("parent_state")
        if parent_state and not self.is_in_state(parent_state):
            self._logger(f"Skipping invoke '{invoke_id}' - parent state '{parent_state}' is no longer active")
            return

        invoke_type = options.get("type", "http://www.w3.org/TR/scxml/")

        # Only SCXML type is supported (with or without trailing slash)
        valid_types = (
            "http://www.w3.org/TR/scxml/",
            "http://www.w3.org/TR/scxml",
            "http://www.w3.org/TR/scxml/#SCXMLEventProcessor",
            "scxml",
        )
        if invoke_type not in valid_types:
            self._raise_platform("error.execution")
            return

        child_class = options.get("child_class")
        src = options.get("src")
        content_expr = options.get("content_expr")
        autoforward = options.get("autoforward", False)
        init_data = options.get("data", {})
        finalize_actions = options.get("finalize_actions", [])

        child: TranspiledStateMachine | None = None

        # Priority 1: Pre-compiled child class
        if child_class is not None:
            try:
                child = child_class()
            except Exception as ex:
                self._logger(f"Failed to instantiate child class: {ex}")
                self._raise_platform("error.execution")
                return

        # Priority 2: Content expression - evaluate and look up by hash (W3C test530)
        elif content_expr is not None:
            try:
                # Evaluate the expression to get the XML content
                content_value = self._data_model.evaluate_expression(content_expr)
                if content_value is None:
                    self._logger(f"Content expression evaluated to None: {content_expr}")
                    self._raise_platform("error.communication")
                    return

                # Convert to string if needed (handle XmlDomWrapper-like objects)
                if hasattr(content_value, 'to_xml_string'):
                    content_str = content_value.to_xml_string()
                elif hasattr(content_value, '__str__'):
                    content_str = str(content_value)
                else:
                    content_str = content_value

                # Compute stable hash using same algorithm as Java CLI
                # hash = hash * 31 + char (with 32-bit unsigned overflow)
                stable_hash = 0
                for c in content_str:
                    stable_hash = (stable_hash * 31 + ord(c)) & 0xFFFFFFFF
                # Java's Integer.toHexString outputs unsigned hex (no negative sign)
                content_key = f"content:{stable_hash:x}"

                # Look up in registry
                registry = getattr(self.__class__, "_INVOKE_REGISTRY", None)
                if registry:
                    child_cls = registry.get(content_key)
                    if child_cls:
                        child = child_cls()
                    else:
                        self._logger(f"No registered child for content hash: {content_key}")
                        self._raise_platform("error.communication")
                        return
                else:
                    self._logger(f"No invoke registry for content expression lookup")
                    self._raise_platform("error.communication")
                    return
            except Exception as ex:
                self._logger(f"Failed to evaluate content expression: {ex}")
                self._raise_platform("error.execution")
                return

        # Priority 3: Registry lookup for src
        elif src is not None:
            registry = getattr(self.__class__, "_INVOKE_REGISTRY", None)
            if registry:
                child_cls = registry.get(src)
                if child_cls is None:
                    # Try with/without file: prefix
                    if src.startswith("file:"):
                        child_cls = registry.get(src[5:])
                    else:
                        child_cls = registry.get("file:" + src)

                if child_cls:
                    try:
                        child = child_cls()
                    except Exception as ex:
                        self._logger(f"Failed to instantiate child from registry: {ex}")
                        self._raise_platform("error.execution")
                        return
                else:
                    self._logger(f"No registered child for src: {src}")
                    self._raise_platform("error.communication")
                    return
            else:
                self._logger(f"No invoke registry and src requires runtime loading: {src}")
                self._raise_platform("error.communication")
                return

        # No source - error
        else:
            self._logger(f"Invoke {invoke_id} has no child_class or src")
            self._raise_platform("error.execution")
            return

        if child is None:
            self._raise_platform("error.execution")
            return

        # Set up parent callback for events from child
        def on_child_event(event: Event) -> None:
            # Set invokeid on the event
            if not event.invokeid:
                event = Event(
                    name=event.name,
                    type=event.type,
                    sendid=event.sendid,
                    origin=event.origin,
                    origintype=event.origintype,
                    invokeid=invoke_id,
                    data=event.data,
                    raw_data=event.raw_data
                )
            else:
                event = Event(
                    name=event.name,
                    type=event.type,
                    sendid=event.sendid,
                    origin=event.origin,
                    origintype=event.origintype,
                    invokeid=event.invokeid,
                    data=event.data,
                    raw_data=event.raw_data
                )

            # Handle done.invoke specially
            if event.name == "done.invoke":
                # Rename to done.invoke.<invoke_id>
                done_event = Event(
                    name=f"done.invoke.{invoke_id}",
                    type="platform",
                    invokeid=invoke_id,
                    data=event.data,
                    raw_data=event.raw_data
                )
                self._runtime_context.enqueue_external(done_event)
            else:
                self._runtime_context.enqueue_external(event)

        child.set_parent_callback(on_child_event)

        # Register the child
        self._runtime_context.register_invoked_child(
            invoke_id=invoke_id,
            child=child,
            autoforward=autoforward,
            finalize_actions=finalize_actions
        )

        # Start the child with init data
        try:
            child.start(init_data)
        except Exception as ex:
            self._logger(f"Failed to start child: {ex}")
            self._runtime_context.cancel_invoke(invoke_id)
            self._raise_platform("error.execution")

    def _send_to_target(self, target: str, event: Event) -> None:
        """
        Sends an event to a target.

        Args:
            target: The target (e.g., "#_parent", "#_internal", "#_<invokeid>").
            event: The event to send.

        Raises:
            RuntimeError: If the target is invalid or communication fails.
        """
        if target == "#_parent":
            self._send_to_parent(event)
        elif target == "#_internal":
            self._runtime_context.enqueue_internal(event)
        elif target == self._runtime_context.origin_uri:
            # Sending to self - enqueue to external queue
            self._runtime_context.enqueue_external(event)
        elif target.startswith("#_scxml_"):
            # Sending to another SCXML session - if it's us, enqueue to external
            # Otherwise it's a different session which we can't reach
            if target == self._runtime_context.origin_uri:
                self._runtime_context.enqueue_external(event)
            else:
                # Different session - can't send directly
                self._logger(f"Cannot send to external session: {target}")
                self._raise_platform("error.communication", event.sendid)
                raise RuntimeError(f"Cannot send to external session: {target}")
        elif target.startswith("#_"):
            # Send to invoked child
            child_invoke_id = target[2:]
            child_info = self._runtime_context.get_invoked_child(child_invoke_id)
            if child_info:
                try:
                    child_info.child.send(event)
                except Exception as ex:
                    self._logger(f"Error sending to child {child_invoke_id}: {ex}")
                    self._raise_platform("error.communication", event.sendid)
                    raise RuntimeError(f"Send to child failed: {ex}") from ex
            else:
                self._logger(f"No child found with invoke ID: {child_invoke_id}")
                self._raise_platform("error.communication", event.sendid)
                raise RuntimeError(f"No child found with invoke ID: {child_invoke_id}")
        else:
            # Unknown target - raise error.execution per W3C spec
            self._logger(f"Unknown send target: {target}")
            self._raise_platform("error.execution", event.sendid)
            raise RuntimeError(f"Unknown send target: {target}")

    # Abstract methods to be implemented by generated code

    @abstractmethod
    def _configure_data_model(self) -> None:
        """Configures the data model with initial values."""
        ...

    @abstractmethod
    def _enter_initial_state(self) -> None:
        """Enters the initial state configuration."""
        ...

    @abstractmethod
    def _dispatch_event(self, event_id: int, event: Event) -> bool:
        """Dispatches an event to active states."""
        ...

    @abstractmethod
    def _check_eventless_transitions(self) -> None:
        """Checks and executes eventless transitions."""
        ...

    @abstractmethod
    def _get_event_id(self, event_name: str) -> int:
        """Gets the event ID for a name (for fast dispatch)."""
        ...

    @abstractmethod
    def _get_state_index(self, state_id: str) -> int:
        """Gets the state index for a state ID."""
        ...

    @abstractmethod
    def _get_state_name(self, index: int) -> str | None:
        """Gets the state name for an index."""
        ...
