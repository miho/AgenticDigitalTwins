"""
SCXML Data Model implementations.
"""

from scxmlgen.datamodel.interface import DataModelType, IDataModel
from scxmlgen.datamodel.null_datamodel import NullDataModel

__all__ = [
    "DataModelType",
    "IDataModel",
    "NullDataModel",
]

# Lazy import for ECMAScript datamodel (requires dukpy)
def get_ecmascript_datamodel():
    """Get ECMAScript datamodel class (lazy import)."""
    from scxmlgen.datamodel.ecmascript_datamodel import ECMAScriptDataModel
    return ECMAScriptDataModel
