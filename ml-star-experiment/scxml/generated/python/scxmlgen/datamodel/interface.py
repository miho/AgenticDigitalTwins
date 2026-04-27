"""
Data model interface for SCXML state machines.
"""

from __future__ import annotations
from abc import ABC, abstractmethod
from enum import Enum, auto
from typing import Any, Callable, TYPE_CHECKING

if TYPE_CHECKING:
    from scxmlgen.event import Event


class DataModelType(Enum):
    """Supported SCXML data model types."""
    NULL = auto()
    ECMASCRIPT = auto()
    NATIVE_PYTHON = auto()


class IDataModel(ABC):
    """
    Interface for SCXML data model implementations.

    Data models provide expression evaluation and variable storage
    for SCXML state machines.
    """

    @property
    @abstractmethod
    def type(self) -> DataModelType:
        """Returns the data model type."""
        ...

    @abstractmethod
    def get(self, name: str) -> Any:
        """Gets a variable value by name."""
        ...

    @abstractmethod
    def set(self, name: str, value: Any) -> None:
        """Sets a variable value."""
        ...

    @abstractmethod
    def set_undefined(self, name: str) -> None:
        """Sets a variable to undefined."""
        ...

    @abstractmethod
    def has(self, name: str) -> bool:
        """Checks if a variable exists."""
        ...

    @abstractmethod
    def evaluate_expression(self, expression: str) -> Any:
        """Evaluates an expression and returns the result."""
        ...

    @abstractmethod
    def evaluate_boolean(self, expression: str) -> bool:
        """Evaluates an expression and returns a boolean result."""
        ...

    @abstractmethod
    def try_evaluate_boolean(self, expression: str) -> tuple[bool, bool]:
        """
        Tries to evaluate an expression as boolean.

        Returns:
            tuple[success: bool, result: bool]
            - success: True if evaluation succeeded, False if it failed
            - result: The boolean result (only valid if success is True)
        """
        ...

    @abstractmethod
    def evaluate_to_string(self, expression: str) -> str:
        """Evaluates an expression and returns a string result."""
        ...

    @abstractmethod
    def execute_script(self, script: str) -> None:
        """Executes a script block."""
        ...

    @abstractmethod
    def set_current_event(self, event: Event | None) -> None:
        """Sets the current event (_event system variable)."""
        ...

    @abstractmethod
    def initialize_system_variables(self, session_id: str, machine_name: str) -> None:
        """Initializes system variables (_sessionid, _name, _ioprocessors)."""
        ...
