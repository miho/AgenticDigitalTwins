"""
Event class for SCXML state machine events.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class Event:
    """
    Represents an SCXML event with name, type, origin, and data.
    Immutable dataclass for thread-safe event passing.
    """
    name: str = ""
    type: str = "external"  # "platform", "internal", or "external"
    sendid: str | None = None
    origin: str | None = None
    origintype: str | None = None
    invokeid: str | None = None
    data: dict[str, Any] | None = None
    raw_data: Any = None

    @staticmethod
    def named(name: str) -> Event:
        """Creates a simple event with just a name."""
        return Event(name=name)

    @staticmethod
    def platform(name: str) -> Event:
        """Creates a platform event (internal to state machine)."""
        return Event(name=name, type="platform")

    @staticmethod
    def internal(name: str) -> Event:
        """Creates an internal event (raised by the state machine)."""
        return Event(name=name, type="internal")

    @staticmethod
    def builder() -> EventBuilder:
        """Creates a new event builder."""
        return EventBuilder()

    def with_origin(self, origin: str) -> Event:
        """Creates a copy of this event with a new origin."""
        return Event(
            name=self.name,
            type=self.type,
            sendid=self.sendid,
            origin=origin,
            origintype=self.origintype,
            invokeid=self.invokeid,
            data=self.data,
            raw_data=self.raw_data,
        )

    def with_invokeid(self, invokeid: str) -> Event:
        """Creates a copy of this event with a new invoke ID."""
        return Event(
            name=self.name,
            type=self.type,
            sendid=self.sendid,
            origin=self.origin,
            origintype=self.origintype,
            invokeid=invokeid,
            data=self.data,
            raw_data=self.raw_data,
        )


class EventBuilder:
    """Fluent builder for constructing Event instances."""

    def __init__(self) -> None:
        self._name: str = ""
        self._type: str = "external"
        self._sendid: str | None = None
        self._origin: str | None = None
        self._origintype: str | None = None
        self._invokeid: str | None = None
        self._data: dict[str, Any] | None = None
        self._raw_data: Any = None

    def name(self, name: str) -> EventBuilder:
        self._name = name
        return self

    def type(self, type_: str) -> EventBuilder:
        self._type = type_
        return self

    def sendid(self, sendid: str) -> EventBuilder:
        self._sendid = sendid
        return self

    def origin(self, origin: str) -> EventBuilder:
        self._origin = origin
        return self

    def origintype(self, origintype: str) -> EventBuilder:
        self._origintype = origintype
        return self

    def invokeid(self, invokeid: str) -> EventBuilder:
        self._invokeid = invokeid
        return self

    def data(self, data: dict[str, Any] | None = None, **kwargs: Any) -> EventBuilder:
        """Set event data. Can pass a dict or keyword arguments."""
        if data is not None:
            self._data = dict(data)
        if kwargs:
            if self._data is None:
                self._data = {}
            self._data.update(kwargs)
        return self

    def raw_data(self, raw_data: Any) -> EventBuilder:
        self._raw_data = raw_data
        return self

    def build(self) -> Event:
        return Event(
            name=self._name,
            type=self._type,
            sendid=self._sendid,
            origin=self._origin,
            origintype=self._origintype,
            invokeid=self._invokeid,
            data=self._data,
            raw_data=self._raw_data,
        )
