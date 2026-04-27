"""
ECMAScript data model implementation using dukpy.

Provides full W3C SCXML ECMAScript data model support.
"""

from __future__ import annotations
import json
import xml.etree.ElementTree as ET
from typing import Any, Callable, TYPE_CHECKING

import dukpy

from scxmlgen.datamodel.interface import DataModelType, IDataModel

if TYPE_CHECKING:
    from scxmlgen.event import Event


# System variables that cannot be modified
SYSTEM_VARIABLES = frozenset(["_sessionid", "_name", "_event", "_ioprocessors", "_x"])

# Reserved keywords that are invalid as expressions
INVALID_EXPRESSION_KEYWORDS = frozenset([
    "return", "break", "continue", "throw", "debugger", "with", "switch",
    "case", "default", "try", "catch", "finally", "do", "while", "for",
    "if", "else", "var", "let", "const", "class", "import", "export"
])


class ECMAScriptDataModel(IDataModel):
    """
    ECMAScript data model implementation using dukpy JavaScript engine.

    Provides full W3C SCXML ECMAScript data model support including:
    - System variables (_sessionid, _name, _event, _ioprocessors)
    - In() predicate for state checks
    - Full JavaScript expression evaluation
    """

    def __init__(self, in_predicate: Callable[[str], bool]) -> None:
        """
        Creates a dukpy-based ECMAScript data model.

        Args:
            in_predicate: Function to check if a state is active (for In() predicate).
        """
        self._in_predicate = in_predicate
        self._interpreter = dukpy.JSInterpreter()
        self._current_event: Event | None = None

        # Initialize the interpreter with helper functions
        self._setup_interpreter()

    def _setup_interpreter(self) -> None:
        """Sets up the JavaScript interpreter with SCXML-specific functions."""
        # We need to handle In() through a different mechanism since dukpy
        # doesn't support direct Python function callbacks the same way Jint does.
        # Instead, we'll inject a special marker and handle it during evaluation.
        pass

    @property
    def type(self) -> DataModelType:
        return DataModelType.ECMASCRIPT

    def get(self, name: str) -> Any:
        """Gets a variable value by name."""
        try:
            result = self._interpreter.evaljs(name)
            return self._js_to_python(result)
        except Exception:
            return None

    def set(self, name: str, value: Any) -> None:
        """Sets a variable value."""
        # Check if trying to modify a system variable
        base_name = name.split(".")[0].split("[")[0].strip()
        if base_name in SYSTEM_VARIABLES:
            raise ValueError(f"Cannot modify system variable: {base_name}")

        # Convert Python value to JS
        js_value = self._python_to_js_literal(value)

        # Check if this is a property path
        if "." in name or "[" in name:
            # For property paths, use assignment
            self._interpreter.evaljs(f"{name} = {js_value}")
        else:
            # Simple variable assignment
            self._interpreter.evaljs(f"var {name} = {js_value}")

    def set_undefined(self, name: str) -> None:
        """Sets a variable to undefined."""
        if name in SYSTEM_VARIABLES:
            raise ValueError(f"Cannot modify system variable: {name}")
        self._interpreter.evaljs(f"var {name} = undefined")

    def has(self, name: str) -> bool:
        """Checks if a variable exists."""
        try:
            result = self._interpreter.evaljs(f"typeof {name} !== 'undefined'")
            return bool(result)
        except Exception:
            return False

    def evaluate_expression(self, expression: str) -> Any:
        """Evaluates an expression and returns the result."""
        trimmed = expression.strip()

        # Check for invalid bare keywords
        if trimmed in INVALID_EXPRESSION_KEYWORDS:
            raise ValueError(f"Invalid expression (bare keyword): {expression}")

        # Handle In() predicate
        expr_with_in = self._handle_in_predicate(expression)

        try:
            result = self._interpreter.evaljs(expr_with_in)
            return self._js_to_python(result)
        except Exception as ex:
            raise ValueError(f"Failed to evaluate expression: {expression}") from ex

    def evaluate_boolean(self, expression: str) -> bool:
        """Evaluates an expression as boolean."""
        success, result = self.try_evaluate_boolean(expression)
        return result

    def try_evaluate_boolean(self, expression: str) -> tuple[bool, bool]:
        """
        Tries to evaluate an expression as boolean.

        Returns:
            tuple[success: bool, result: bool]
        """
        trimmed = expression.strip()

        # Check for invalid bare keywords
        if trimmed in INVALID_EXPRESSION_KEYWORDS:
            return (False, False)

        # Handle In() predicate
        expr_with_in = self._handle_in_predicate(expression)

        try:
            result = self._interpreter.evaljs(expr_with_in)
            # Convert to Python bool
            if result is None:
                return (True, False)
            if isinstance(result, bool):
                return (True, result)
            if isinstance(result, (int, float)):
                return (True, result != 0)
            if isinstance(result, str):
                return (True, len(result) > 0)
            return (True, True)
        except Exception:
            return (False, False)

    def evaluate_to_string(self, expression: str) -> str:
        """Evaluates an expression to string."""
        try:
            expr_with_in = self._handle_in_predicate(expression)
            result = self._interpreter.evaljs(expr_with_in)
            if result is None:
                return ""
            return str(result)
        except Exception:
            return ""

    def assign(self, location: str, expression: str) -> None:
        """
        Assigns the result of an expression to a location.

        This executes the assignment directly in JavaScript to preserve object references.
        This is important for system variable comparisons like `Var1 == _event`.
        """
        # Check if trying to modify a system variable
        base_name = location.split(".")[0].split("[")[0].strip()
        if base_name in SYSTEM_VARIABLES:
            raise ValueError(f"Cannot modify system variable: {base_name}")

        # Handle In() predicate in the expression
        expr_with_in = self._handle_in_predicate(expression)

        try:
            # Check if location already exists (for property assignment vs var declaration)
            location_exists = False
            try:
                self._interpreter.evaljs(f"typeof {location.split('.')[0].split('[')[0]} !== 'undefined'")
                location_exists = True
            except Exception:
                pass

            if location_exists:
                # Direct assignment for existing variables or property paths
                self._interpreter.evaljs(f"{location} = {expr_with_in}")
            else:
                # Need var declaration for new variables
                self._interpreter.evaljs(f"var {location} = {expr_with_in}")
        except Exception as ex:
            raise ValueError(f"Assignment failed: {location} = {expression}") from ex

    def execute_script(self, script: str) -> None:
        """Executes a script block."""
        # Check if script is trying to assign to a system variable
        trimmed = script.strip()
        for sys_var in SYSTEM_VARIABLES:
            if trimmed.startswith(sys_var):
                rest = trimmed[len(sys_var):].lstrip()
                if rest.startswith("="):
                    raise ValueError(f"Cannot modify system variable: {sys_var}")

        # Handle In() predicate in scripts
        script_with_in = self._handle_in_predicate(script)

        try:
            self._interpreter.evaljs(script_with_in)
        except Exception as ex:
            raise ValueError(f"Script execution failed: {ex}") from ex

    def set_current_event(self, event: Event | None) -> None:
        """Sets the current event (_event system variable)."""
        self._current_event = event

        if event is None:
            self._interpreter.evaljs("var _event = undefined")
            return

        # Build _event in JavaScript to properly use 'undefined' for missing values
        # W3C tests require all keys to exist (test330) but with undefined values (test335, test337, test339)
        parts = [
            f"name: '{self._escape_js_string(event.name)}'",
            f"type: '{self._escape_js_string(event.type)}'",
        ]

        # Add optional fields with undefined if not set
        if event.sendid is not None:
            parts.append(f"sendid: '{self._escape_js_string(event.sendid)}'")
        else:
            parts.append("sendid: undefined")

        if event.origin is not None:
            parts.append(f"origin: '{self._escape_js_string(event.origin)}'")
        else:
            parts.append("origin: undefined")

        if event.origintype is not None:
            parts.append(f"origintype: '{self._escape_js_string(event.origintype)}'")
        else:
            parts.append("origintype: undefined")

        if event.invokeid is not None:
            parts.append(f"invokeid: '{self._escape_js_string(event.invokeid)}'")
        else:
            parts.append("invokeid: undefined")

        # Handle data
        if event.data:
            parts.append(f"data: {self._python_to_js_literal(event.data)}")
        elif event.raw_data is not None:
            if isinstance(event.raw_data, str):
                raw = event.raw_data.strip()
                # Check for XML marker (test561: XML in event data)
                if raw.startswith("<?xml?>"):
                    xml_content = raw[7:]
                    try:
                        root = ET.fromstring(xml_content)
                        dom_js = self._xml_element_to_js(root)
                        parts.append(f"data: {dom_js}")
                    except ET.ParseError:
                        parts.append(f"data: '{self._escape_js_string(event.raw_data)}'")
                # Check for raw XML (without marker)
                elif raw.startswith("<") and raw.endswith(">"):
                    try:
                        root = ET.fromstring(raw)
                        dom_js = self._xml_element_to_js(root)
                        parts.append(f"data: {dom_js}")
                    except ET.ParseError:
                        parts.append(f"data: '{self._escape_js_string(event.raw_data)}'")
                # Try to parse JSON if it looks like JSON
                elif (raw.startswith("{") and raw.endswith("}")) or \
                     (raw.startswith("[") and raw.endswith("]")):
                    try:
                        parsed = json.loads(raw)
                        parts.append(f"data: {self._python_to_js_literal(parsed)}")
                    except json.JSONDecodeError:
                        parts.append(f"data: '{self._escape_js_string(event.raw_data)}'")
                else:
                    parts.append(f"data: '{self._escape_js_string(event.raw_data)}'")
            else:
                parts.append(f"data: {self._python_to_js_literal(event.raw_data)}")
        else:
            parts.append("data: undefined")

        js_obj = "{ " + ", ".join(parts) + " }"
        self._interpreter.evaljs(f"var _event = {js_obj}")

    def initialize_system_variables(self, session_id: str, machine_name: str) -> None:
        """Initializes system variables."""
        self._interpreter.evaljs(f"var _sessionid = '{self._escape_js_string(session_id)}'")
        self._interpreter.evaljs(f"var _name = '{self._escape_js_string(machine_name)}'")

        # Initialize _ioprocessors per W3C spec
        ioprocessors_js = """
        var _ioprocessors = {
            scxml: { location: '#_internal' },
            'http://www.w3.org/TR/scxml/#SCXMLEventProcessor': { location: '#_scxml_' + _sessionid }
        }
        """
        self._interpreter.evaljs(ioprocessors_js)

    def _handle_in_predicate(self, expression: str) -> str:
        """
        Handles In() predicates by evaluating them and replacing with boolean literals.

        This is necessary because dukpy doesn't support Python function callbacks
        directly from JavaScript.
        """
        import re

        # Pattern to match In('stateId') or In("stateId")
        pattern = r'In\s*\(\s*[\'"]([^\'"]+)[\'"]\s*\)'

        def replace_in(match: re.Match) -> str:
            state_id = match.group(1)
            result = self._in_predicate(state_id)
            return "true" if result else "false"

        return re.sub(pattern, replace_in, expression)

    def set_xml(self, name: str, xml_content: str) -> None:
        """
        Sets a variable to an XML DOM-like object.

        Parses the XML and creates a JavaScript object structure that supports
        DOM methods like getElementsByTagName and getAttribute.
        """
        if name in SYSTEM_VARIABLES:
            raise ValueError(f"Cannot modify system variable: {name}")

        try:
            # Parse XML
            root = ET.fromstring(xml_content)

            # Generate JavaScript code for a DOM-like structure
            js_code = self._xml_element_to_js(root)

            # Create the variable with the DOM structure
            self._interpreter.evaljs(f"var {name} = {js_code}")
        except ET.ParseError as e:
            raise ValueError(f"Invalid XML content: {e}") from e

    def _xml_element_to_js(self, element: ET.Element) -> str:
        """Converts an XML element to a JavaScript DOM-like object."""
        # Get local name (strip namespace)
        tag = element.tag
        if "}" in tag:
            tag = tag.split("}")[1]

        # Build attributes object
        attrs_parts = []
        for attr_name, attr_val in element.attrib.items():
            # Strip namespace from attribute names too
            if "}" in attr_name:
                attr_name = attr_name.split("}")[1]
            attrs_parts.append(f"'{self._escape_js_string(attr_name)}': '{self._escape_js_string(attr_val)}'")
        attrs_js = "{" + ", ".join(attrs_parts) + "}"

        # Build children array
        children_parts = []
        for child in element:
            children_parts.append(self._xml_element_to_js(child))
        children_js = "[" + ", ".join(children_parts) + "]"

        # Get text content
        text = element.text or ""
        tail = element.tail or ""
        text_content = self._escape_js_string(text.strip())

        # Build the DOM-like object
        js_code = f"""(function() {{
            var node = {{
                _tagName: '{self._escape_js_string(tag)}',
                _attrs: {attrs_js},
                _children: {children_js},
                _textContent: '{text_content}',
                tagName: '{self._escape_js_string(tag)}',
                getAttribute: function(name) {{
                    return this._attrs[name] !== undefined ? this._attrs[name] : null;
                }},
                hasAttribute: function(name) {{
                    return this._attrs[name] !== undefined;
                }},
                getElementsByTagName: function(name) {{
                    var results = [];
                    function search(n) {{
                        if (n._tagName === name) results.push(n);
                        for (var i = 0; i < n._children.length; i++) search(n._children[i]);
                    }}
                    for (var i = 0; i < this._children.length; i++) search(this._children[i]);
                    return results;
                }},
                get textContent() {{
                    var text = this._textContent;
                    for (var i = 0; i < this._children.length; i++) {{
                        text += this._children[i].textContent;
                    }}
                    return text;
                }},
                get childNodes() {{
                    return this._children;
                }},
                get firstChild() {{
                    return this._children.length > 0 ? this._children[0] : null;
                }}
            }};
            return node;
        }}())"""

        return js_code

    def _python_to_js_literal(self, value: Any) -> str:
        """Converts a Python value to a JavaScript literal string."""
        if value is None:
            return "null"
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, (int, float)):
            return str(value)
        if isinstance(value, str):
            return f"'{self._escape_js_string(value)}'"
        if isinstance(value, dict):
            pairs = []
            for k, v in value.items():
                pairs.append(f"'{self._escape_js_string(k)}': {self._python_to_js_literal(v)}")
            return "{" + ", ".join(pairs) + "}"
        if isinstance(value, (list, tuple)):
            items = [self._python_to_js_literal(v) for v in value]
            return "[" + ", ".join(items) + "]"
        # Fallback: try JSON
        try:
            return json.dumps(value)
        except (TypeError, ValueError):
            return f"'{self._escape_js_string(str(value))}'"

    def _js_to_python(self, value: Any) -> Any:
        """Converts a JavaScript value from dukpy to Python."""
        # dukpy already converts most types automatically
        return value

    @staticmethod
    def _escape_js_string(s: str) -> str:
        """Escapes a string for use in JavaScript."""
        if s is None:
            return ""
        return (s.replace("\\", "\\\\")
                 .replace("'", "\\'")
                 .replace("\n", "\\n")
                 .replace("\r", "\\r")
                 .replace("\t", "\\t"))
