"""
Null data model implementation.

Per W3C spec, the null datamodel has no data storage and only supports
the In() predicate. All conditions without In() evaluate to false.
"""

from __future__ import annotations
from typing import Any, Callable, TYPE_CHECKING

from scxmlgen.datamodel.interface import DataModelType, IDataModel

if TYPE_CHECKING:
    from scxmlgen.event import Event


class NullDataModel(IDataModel):
    """
    Null data model implementation.

    Per W3C SCXML spec:
    - No data storage capability
    - Only supports the In(stateId) predicate
    - All conditions without In() evaluate to false
    """

    def __init__(self, in_predicate: Callable[[str], bool]) -> None:
        """
        Creates a null data model.

        Args:
            in_predicate: Function to check if a state is active (for In() predicate).
        """
        self._in_predicate = in_predicate
        self._session_id: str = ""
        self._machine_name: str = ""

    @property
    def type(self) -> DataModelType:
        return DataModelType.NULL

    def get(self, name: str) -> Any:
        """Null datamodel has no variables."""
        return None

    def set(self, name: str, value: Any) -> None:
        """Null datamodel cannot store variables."""
        pass

    def set_undefined(self, name: str) -> None:
        """Null datamodel cannot store variables."""
        pass

    def has(self, name: str) -> bool:
        """Null datamodel has no variables."""
        return False

    def evaluate_expression(self, expression: str) -> Any:
        """
        Evaluates an expression.

        For null datamodel, only In() predicate is supported.
        """
        return self._evaluate_in_expression(expression)

    def evaluate_boolean(self, expression: str) -> bool:
        """
        Evaluates an expression as boolean.

        For null datamodel, only In() predicate returns true.
        All other expressions return false.
        """
        result = self._evaluate_in_expression(expression)
        return bool(result) if result is not None else False

    def try_evaluate_boolean(self, expression: str) -> tuple[bool, bool]:
        """
        Tries to evaluate an expression as boolean.

        For null datamodel, In() expressions succeed, others return false.
        """
        result = self._evaluate_in_expression(expression)
        if result is not None:
            return (True, bool(result))
        # Per W3C spec: non-In() conditions evaluate to false in null datamodel
        return (True, False)

    def evaluate_to_string(self, expression: str) -> str:
        """Evaluates an expression to string."""
        result = self._evaluate_in_expression(expression)
        return str(result) if result is not None else ""

    def execute_script(self, script: str) -> None:
        """Null datamodel cannot execute scripts."""
        pass

    def set_current_event(self, event: Event | None) -> None:
        """Null datamodel doesn't track events."""
        pass

    def initialize_system_variables(self, session_id: str, machine_name: str) -> None:
        """Store system variables for reference."""
        self._session_id = session_id
        self._machine_name = machine_name

    def _evaluate_in_expression(self, expression: str) -> bool | None:
        """
        Evaluates In() predicate expressions.

        Returns:
            True/False if expression is an In() predicate, None otherwise.
        """
        expr = expression.strip()

        # Check for In('stateId') or In("stateId") pattern
        if expr.startswith("In(") and expr.endswith(")"):
            inner = expr[3:-1].strip()
            # Remove quotes
            if (inner.startswith("'") and inner.endswith("'")) or \
               (inner.startswith('"') and inner.endswith('"')):
                state_id = inner[1:-1]
                return self._in_predicate(state_id)

        # Check for negated In() - !In('stateId') or not In('stateId')
        if expr.startswith("!") or expr.startswith("not "):
            inner_expr = expr[1:].strip() if expr.startswith("!") else expr[4:].strip()
            result = self._evaluate_in_expression(inner_expr)
            if result is not None:
                return not result

        # Check for In() && In() or In() and In() combinations
        # Also supports In() || In() or In() or In()
        for op in [" && ", " and ", " || ", " or "]:
            if op in expr:
                parts = expr.split(op, 1)
                left = self._evaluate_in_expression(parts[0])
                right = self._evaluate_in_expression(parts[1])
                if left is not None and right is not None:
                    if "&&" in op or "and" in op:
                        return left and right
                    else:
                        return left or right
                # If either side is not an In() expression, return None
                return None

        return None
