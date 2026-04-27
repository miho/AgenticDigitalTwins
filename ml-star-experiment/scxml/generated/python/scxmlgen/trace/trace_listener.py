"""
Trace listener interface for SCXML state machine debugging.
"""

from __future__ import annotations
from abc import ABC, abstractmethod
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from scxmlgen.event import Event


class ITraceListener(ABC):
    """
    Interface for trace listeners that receive state machine execution events.
    """

    @abstractmethod
    def on_session_start(
        self,
        session_id: str,
        machine_name: str,
        data_model_type: str,
        timestamp_us: int
    ) -> None:
        """Called when a state machine session starts."""
        ...

    @abstractmethod
    def on_session_end(
        self,
        session_id: str,
        final_states: frozenset[str],
        timestamp_us: int
    ) -> None:
        """Called when a state machine session ends."""
        ...

    @abstractmethod
    def on_state_enter(
        self,
        state_id: str,
        timestamp_us: int
    ) -> None:
        """Called when entering a state."""
        ...

    @abstractmethod
    def on_state_exit(
        self,
        state_id: str,
        timestamp_us: int
    ) -> None:
        """Called when exiting a state."""
        ...

    @abstractmethod
    def on_transition(
        self,
        source_state: str | None,
        target_state: str,
        event_name: str | None,
        timestamp_us: int
    ) -> None:
        """Called when a transition fires."""
        ...

    @abstractmethod
    def on_event_received(
        self,
        event: Event,
        timestamp_us: int
    ) -> None:
        """Called when an event is received for processing."""
        ...

    @abstractmethod
    def on_event_processed(
        self,
        event: Event,
        timestamp_us: int
    ) -> None:
        """Called when an event has been processed."""
        ...

    @abstractmethod
    def on_variable_changed(
        self,
        name: str,
        old_value: Any,
        new_value: Any,
        timestamp_us: int
    ) -> None:
        """Called when a data model variable changes value."""
        ...

    @abstractmethod
    def on_action_execute(
        self,
        action_type: str,
        details: dict[str, Any],
        timestamp_us: int
    ) -> None:
        """Called when an executable action is performed."""
        ...


class IInvokeAwareTraceListener(ITraceListener):
    """
    Extended TraceListener interface that includes invoke context for all events.

    Implementations receive an additional invoke_id parameter for each event,
    allowing filtering or routing based on which state machine generated them.

    The invoke ID is:
    - None for events from the parent/root state machine
    - The invoke ID string (e.g., "heaterControl") for events from invoked children
    """

    @abstractmethod
    def on_session_start_invoke(
        self,
        session_id: str,
        machine_name: str,
        data_model_type: str,
        timestamp_us: int,
        invoke_id: str | None
    ) -> None:
        """Called when a state machine session starts."""
        ...

    @abstractmethod
    def on_session_end_invoke(
        self,
        session_id: str,
        final_states: frozenset[str],
        timestamp_us: int,
        invoke_id: str | None
    ) -> None:
        """Called when a state machine session ends."""
        ...

    @abstractmethod
    def on_state_enter_invoke(
        self,
        state_id: str,
        timestamp_us: int,
        invoke_id: str | None
    ) -> None:
        """Called when entering a state."""
        ...

    @abstractmethod
    def on_state_exit_invoke(
        self,
        state_id: str,
        timestamp_us: int,
        invoke_id: str | None
    ) -> None:
        """Called when exiting a state."""
        ...

    @abstractmethod
    def on_transition_invoke(
        self,
        source_state: str | None,
        target_state: str,
        event_name: str | None,
        timestamp_us: int,
        invoke_id: str | None
    ) -> None:
        """Called when a transition fires."""
        ...

    @abstractmethod
    def on_event_received_invoke(
        self,
        event: Event,
        timestamp_us: int,
        invoke_id: str | None
    ) -> None:
        """Called when an event is received for processing."""
        ...

    @abstractmethod
    def on_event_processed_invoke(
        self,
        event: Event,
        timestamp_us: int,
        invoke_id: str | None
    ) -> None:
        """Called when an event has been processed."""
        ...

    @abstractmethod
    def on_variable_changed_invoke(
        self,
        name: str,
        old_value: Any,
        new_value: Any,
        timestamp_us: int,
        invoke_id: str | None
    ) -> None:
        """Called when a data model variable changes value."""
        ...

    @abstractmethod
    def on_action_execute_invoke(
        self,
        action_type: str,
        details: dict[str, Any],
        timestamp_us: int,
        invoke_id: str | None
    ) -> None:
        """Called when an executable action is performed."""
        ...
