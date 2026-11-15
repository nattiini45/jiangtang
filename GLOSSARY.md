# Devices and what is known about them

How Jiangtang describes the things a media or facilities team looks after: what kind of thing a
device is, which model it is, what that model can do, and what this unit says about itself.

## Things

**Work plan** (Arbeitsplan):
A recurring round or device inspection with its target set, sourced basis, responsible person
and month interval or explicit semester anchors. It produces the next dates from recorded work,
not from a separately maintained task list.

**Semester start** (Semesterbeginn):
An administrator-entered date that anchors a pre-semester plan. Its round is due the day before.
The semester cadence is a team policy, not a regulatory inspection period.

**Device kind** (Geräteart):
A named class of device a team looks after, such as projector, wireless receiver or hearing loop.
_Avoid_: device type, Gerätetyp, category

**Function group** (Funktionsgruppe):
A grouping of device kinds by the job they do in a room, such as display, audio or control.
_Avoid_: section, area

**Model** (Modell):
A product a manufacturer sells under one name, of one device kind; every unit of it shares its
data sheet and its ports.
_Avoid_: type, Typ, Gerätemodell, product

**Device** (Gerät):
One physical unit a team owns, of one device kind and usually of one model.
_Avoid_: equipment, Ausstattung, asset, item

**Part** (Teil):
A device kind whose units are used by or fitted into another device, such as a lamp, an air
filter, a lens or a battery pack; consumable, spare and accessory are its roles.
_Avoid_: Ersatzteil (as the general word), component, accessory (as the general word)

**Stock** (Bestand):
The count of a model or item held in store, not yet fitted or handed out.
_Avoid_: inventory, Lager

**Port** (Anschluss):
A connector on a model or device, with its signal and direction.
_Avoid_: connector (as the record), interface, Schnittstelle

## Knowledge

**Property** (Eigenschaft):
A named fact a device kind records about its devices or their model, with a type and, where it
applies, a unit and options.
_Avoid_: field, Feld, attribute, custom field

**Library property** (Eigenschaft aus der Bibliothek):
A property Jiangtang ships for a device kind, named and explained by Jiangtang.
_Avoid_: preset field, system field, default field

**Own property** (eigene Eigenschaft):
A property a team defines itself for what only it needs.
_Avoid_: custom field, user field

**Model value** (Modellwert):
The value of a property that holds for every unit of a model, kept once on the model.
_Avoid_: default value, inherited value

**Data sheet** (Datenblatt):
The model values of a model, taken from its manufacturer's published specification.
_Avoid_: specs, spec sheet, technische Daten

**Reading** (Messwert):
A value a device reports or a person reads off it, with the time it was observed and its source.
_Avoid_: status field, Zählerstand, measurement (for a fixed fact)

**Relation** (Verknüpfung):
A link from a device or model to another record, such as the lamp a projector model takes or the
lens fitted to a unit.
_Avoid_: link (that is a web address), reference, Bezug

## Sources

**Library** (Bibliothek):
The device kinds, function groups and properties Jiangtang ships for the trade, in German and
English, with their sources.
_Avoid_: presets, templates, Vorlagen

**Catalog** (Katalog):
The models Jiangtang ships with their data sheets, ports and manufacturer pages, from which a team
picks instead of typing.
_Avoid_: model catalog (for a team's own models), database, Modellkatalog

## Functions

**Function** (Funktion):
A job a room does for the people using it, such as picture, sound and microphones or control,
served by the devices of certain kinds.
_Avoid_: feature, Ausstattungsmerkmal, capability, service

**Carrier** (tragendes Gerät):
A device kind a function needs at least one working unit of, such as the projector for the picture.
_Avoid_: main device, primary device

**Path device** (Gerät im Signalweg):
A device kind a function's signal passes through without being the function itself, such as a
matrix switcher or an extender.
_Avoid_: infrastructure, intermediate device

**Room type** (Raumtyp):
A named class of room that lists the functions a room of that type should have.
_Avoid_: room category, Raumart, template

**Expected function** (erwartete Funktion):
A function a room should have, from its room type or set for the room itself.
_Avoid_: required function, Soll-Ausstattung

**Gap** (Lücke):
An expected function with no carrier device in the room. Path devices alone do not fill a gap.
_Avoid_: missing device, defect

## State

**Function state** (Funktionszustand):
What Jiangtang concludes about a function in a room from its devices, open faults, checks and any
state set by hand: works, limited, doesn't work, or no known fault.
_Avoid_: room status (that is the room's typed status), health, availability

**Works** (geht):
The function was confirmed by a check that is newer than everything known against it and still
inside the confirmation window.
_Avoid_: ok, green, available

**No known fault** (keine Störung bekannt):
Nothing is known against the function, but no recent check confirms it.
_Avoid_: works, ok, unknown

**Limited** (eingeschränkt):
The function can be used, but not fully: one of several carriers is out, a path device is out, or
someone reported it so.
_Avoid_: degraded, partial, warning

**Doesn't work** (geht nicht):
The function cannot be used: every carrier is out, or someone reported it so.
_Avoid_: down (in the interface), broken, defekt

**State set by hand** (manuell festgelegter Zustand):
A function state a person sets with a reason; it holds until something newer is known about the
function or until its end date.
_Avoid_: override (in the interface), manual status

## Work

**Fault** (Störung):
A ticket of type incident that says something in a room doesn't work or is limited, optionally
naming the function and the device.
_Avoid_: incident (in the interface), defect, issue, Defekt, Problem

**Impact** (Auswirkung):
How badly a fault affects its function: limited or doesn't work.
_Avoid_: severity, priority

**Channel** (Eingangsweg):
How a fault reached the team: desktop, phone, round, e-mail, monitoring or an agent.
_Avoid_: source (that is where a reading comes from), origin

**Check** (Prüfung):
One person's result for one function in one room at one time: works, limited, doesn't work or not
checked.
_Avoid_: test, inspection (that is a recurring legal check), Kontrolle

**Round** (Rundgang):
A walk through a set of rooms in which each room's functions are checked.
_Avoid_: tour, inspection, Begehung

**Confirmation window** (Bestätigungsfrist):
How long a check counts as confirming a function; after it the function shows no known fault.
_Avoid_: validity, expiry

**Known fix** (bekannte Lösung):
What helped with a fault in a room, kept with the room so the next person finds it.
_Avoid_: known issue, workaround (as the record), tip, Hinweis
