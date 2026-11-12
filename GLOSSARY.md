# Devices and what is known about them

How Jiangtang describes the things a media or facilities team looks after: what kind of thing a
device is, which model it is, what that model can do, and what this unit says about itself.

## Things

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
