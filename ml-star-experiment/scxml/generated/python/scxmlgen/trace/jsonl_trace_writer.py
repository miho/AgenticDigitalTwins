"""
JSONL trace writer for SCXML state machine debugging.

Writes trace events to a JSONL file, compatible with other targets
(Java, C#, JavaScript) for cross-platform trace analysis.
"""

from __future__ import annotations
import json
import time
import threading
from io import TextIOWrapper
from typing import Any, TYPE_CHECKING

from scxmlgen.trace.trace_listener import IInvokeAwareTraceListener

if TYPE_CHECKING:
    from scxmlgen.event import Event


class JsonlTraceWriter(IInvokeAwareTraceListener):
    """
    Production-ready TraceListener that writes trace events to a JSONL file.

    Each trace event is written as a single JSON object per line (JSON Lines format),
    compatible with Java's JsonlTraceWriter for cross-target playback.

    Example output::

        {"timestamp":0,"type":"session_start","session_id":"abc123","scxml_name":"TrafficLight","datamodel":"ecmascript"}
        {"timestamp":1234,"type":"state_enter","state_id":"red"}
        {"timestamp":2345,"type":"transition","from":"red","to":"green","event":"timer"}
        {"timestamp":3456,"type":"state_exit","state_id":"green","invoke_id":"childMachine"}

    Performance Notes:
        - With auto_flush=True (default): Safe for crash analysis
        - With auto_flush=False: Higher throughput, call flush() periodically
    """

    def __init__(
        self,
        file_path: str | None = None,
        stream: TextIOWrapper | None = None,
        auto_flush: bool = True
    ) -> None:
        """
        Creates a new JSONL trace writer.

        Args:
            file_path: Path to the output file. Either file_path or stream must be provided.
            stream: Output stream to write to. If provided, file_path is ignored.
            auto_flush: If True, flush after each line (safer but slower).
        """
        if stream is not None:
            self._writer = stream
            self._owns_writer = False
        elif file_path is not None:
            self._writer = open(file_path, 'w', encoding='utf-8')
            self._owns_writer = True
        else:
            raise ValueError("Either file_path or stream must be provided")

        self._auto_flush = auto_flush
        self._lock = threading.Lock()
        self._disposed = False

    @staticmethod
    def get_timestamp_micros() -> int:
        """Gets the current timestamp in microseconds."""
        return int(time.time() * 1_000_000)

    def _write_line(self, data: dict[str, Any]) -> None:
        """Writes a JSON line to the output."""
        with self._lock:
            if self._disposed:
                return
            self._writer.write(json.dumps(data, separators=(',', ':')))
            self._writer.write('\n')
            if self._auto_flush:
                self._writer.flush()

    def flush(self) -> None:
        """Flushes any buffered output."""
        with self._lock:
            if not self._disposed:
                self._writer.flush()

    def close(self) -> None:
        """Closes the writer and releases resources."""
        with self._lock:
            if not self._disposed:
                self._disposed = True
                if self._owns_writer:
                    self._writer.close()

    def __enter__(self) -> "JsonlTraceWriter":
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        self.close()

    # ITraceListener methods (delegate to invoke-aware versions)

    def on_session_start(
        self, session_id: str, machine_name: str, data_model_type: str, timestamp_us: int
    ) -> None:
        self.on_session_start_invoke(session_id, machine_name, data_model_type, timestamp_us, None)

    def on_session_end(
        self, session_id: str, final_states: frozenset[str], timestamp_us: int
    ) -> None:
        self.on_session_end_invoke(session_id, final_states, timestamp_us, None)

    def on_state_enter(self, state_id: str, timestamp_us: int) -> None:
        self.on_state_enter_invoke(state_id, timestamp_us, None)

    def on_state_exit(self, state_id: str, timestamp_us: int) -> None:
        self.on_state_exit_invoke(state_id, timestamp_us, None)

    def on_transition(
        self, source_state: str | None, target_state: str, event_name: str | None, timestamp_us: int
    ) -> None:
        self.on_transition_invoke(source_state, target_state, event_name, timestamp_us, None)

    def on_event_received(self, event: Event, timestamp_us: int) -> None:
        self.on_event_received_invoke(event, timestamp_us, None)

    def on_event_processed(self, event: Event, timestamp_us: int) -> None:
        self.on_event_processed_invoke(event, timestamp_us, None)

    def on_variable_changed(
        self, name: str, old_value: Any, new_value: Any, timestamp_us: int
    ) -> None:
        self.on_variable_changed_invoke(name, old_value, new_value, timestamp_us, None)

    def on_action_execute(
        self, action_type: str, details: dict[str, Any], timestamp_us: int
    ) -> None:
        self.on_action_execute_invoke(action_type, details, timestamp_us, None)

    # IInvokeAwareTraceListener methods

    def on_session_start_invoke(
        self, session_id: str, machine_name: str, data_model_type: str, timestamp_us: int, invoke_id: str | None
    ) -> None:
        data: dict[str, Any] = {
            "timestamp": timestamp_us,
            "type": "session_start",
            "session_id": session_id,
            "scxml_name": machine_name,
            "datamodel": data_model_type,
        }
        if invoke_id is not None:
            data["invoke_id"] = invoke_id
        self._write_line(data)

    def on_session_end_invoke(
        self, session_id: str, final_states: frozenset[str], timestamp_us: int, invoke_id: str | None
    ) -> None:
        data: dict[str, Any] = {
            "timestamp": timestamp_us,
            "type": "session_end",
            "final_states": list(final_states),
        }
        if invoke_id is not None:
            data["invoke_id"] = invoke_id
        self._write_line(data)

    def on_state_enter_invoke(self, state_id: str, timestamp_us: int, invoke_id: str | None) -> None:
        data: dict[str, Any] = {
            "timestamp": timestamp_us,
            "type": "state_enter",
            "state_id": state_id,
        }
        if invoke_id is not None:
            data["invoke_id"] = invoke_id
        self._write_line(data)

    def on_state_exit_invoke(self, state_id: str, timestamp_us: int, invoke_id: str | None) -> None:
        data: dict[str, Any] = {
            "timestamp": timestamp_us,
            "type": "state_exit",
            "state_id": state_id,
        }
        if invoke_id is not None:
            data["invoke_id"] = invoke_id
        self._write_line(data)

    def on_transition_invoke(
        self, source_state: str | None, target_state: str, event_name: str | None, timestamp_us: int, invoke_id: str | None
    ) -> None:
        data: dict[str, Any] = {
            "timestamp": timestamp_us,
            "type": "transition",
            "from": source_state,
            "to": target_state,
            "event": event_name,
        }
        if invoke_id is not None:
            data["invoke_id"] = invoke_id
        self._write_line(data)

    def on_event_received_invoke(self, event: Event, timestamp_us: int, invoke_id: str | None) -> None:
        data: dict[str, Any] = {
            "timestamp": timestamp_us,
            "type": "event_received",
            "event_name": event.name,
            "event_type": str(event.type),
        }
        if event.data:
            data["event_data"] = dict(event.data)
        if invoke_id is not None:
            data["invoke_id"] = invoke_id
        self._write_line(data)

    def on_event_processed_invoke(self, event: Event, timestamp_us: int, invoke_id: str | None) -> None:
        data: dict[str, Any] = {
            "timestamp": timestamp_us,
            "type": "event_processed",
            "event_name": event.name,
        }
        if invoke_id is not None:
            data["invoke_id"] = invoke_id
        self._write_line(data)

    def on_variable_changed_invoke(
        self, name: str, old_value: Any, new_value: Any, timestamp_us: int, invoke_id: str | None
    ) -> None:
        data: dict[str, Any] = {
            "timestamp": timestamp_us,
            "type": "variable_changed",
            "variable_name": name,
            "old_value": self._to_json_value(old_value),
            "new_value": self._to_json_value(new_value),
        }
        if invoke_id is not None:
            data["invoke_id"] = invoke_id
        self._write_line(data)

    def on_action_execute_invoke(
        self, action_type: str, details: dict[str, Any], timestamp_us: int, invoke_id: str | None
    ) -> None:
        data: dict[str, Any] = {
            "timestamp": timestamp_us,
            "type": "action_execute",
            "action_type": action_type,
            "details": details,
        }
        if invoke_id is not None:
            data["invoke_id"] = invoke_id
        self._write_line(data)

    @staticmethod
    def _to_json_value(value: Any) -> Any:
        """Converts a value to a JSON-serializable form."""
        if value is None or isinstance(value, (bool, int, float, str)):
            return value
        if isinstance(value, dict):
            return {str(k): JsonlTraceWriter._to_json_value(v) for k, v in value.items()}
        if isinstance(value, (list, tuple, set, frozenset)):
            return [JsonlTraceWriter._to_json_value(v) for v in value]
        return str(value)
