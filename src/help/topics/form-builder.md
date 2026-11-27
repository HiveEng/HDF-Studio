---
title: Building forms
section: Fill and sign
order: 4
keywords: form builder, prepare form, create form, add field, detect fields, fillable, text field, check box, radio button, dropdown, list box, signature field, calculation, formula, sum, format, currency, date, required, validation, tab order
summary: Turn a flat form into a fillable one, add and arrange fields, and set formats and calculations.
---
# Building forms

Use **Fill & Sign › Prepare form** ([[Ctrl+Shift+F]]) to add, move and edit form fields. Fields show as outlined boxes while you design.

![Designing a form: the field types across the top, fields outlined on the page](form-designer.png "wide")

## Make a flat form fillable automatically

Click **Detect fields**. {{app}} looks for blanks, lines and boxes and suggests fields for them. Review the suggestions on the page, then click **Add** to keep them or **Discard**. Draw any it missed yourself.

## Adding fields

Pick a field type, then drag a box on the page (or click for a standard size):

| Type | Key | Use for |
|---|---|---|
| **Text** | [[T]] | Names, numbers, dates, notes |
| **Check box** | [[C]] | Yes or no |
| **Radio** | [[R]] | One choice from a group. Buttons placed one after another form a group. |
| **Dropdown** | [[D]] | One choice from a list |
| **List** | [[L]] | One or more choices from a visible list |
| **Signature** | [[S]] | Where someone signs |

Dropdowns and lists ask for their choices, separated by commas.

## Arranging fields

- Drag a field to move it; drag its corner to resize it.
- Arrow keys nudge the selected field.
- [[Delete]] removes it.
- Double-click a field for its properties.

## Field properties

| Property | What it does |
|---|---|
| **Name** | Identifies the field; used when filling from a spreadsheet and exporting data. Radio buttons share a group name. |
| **Tooltip** | Shown when someone hovers over the field. |
| **Required** / **Read only** | Must be filled in / can't be changed. |
| **Font size** | 0 fits the text to the box. |
| **Multiple lines**, **Character limit** | For text fields. |
| **Format** | Plain text, number, currency, percent or date, with decimal places, currency symbol and number style. |
| **Calculate** | Sum, product, average, minimum or maximum of other fields, or a formula such as `Qty * Price`. |
| **Lowest / highest allowed value** | Rejects numbers outside the range. |
| **Choices** | For dropdowns and lists. |

Calculated fields update as people fill in the form, in {{app}} and in other PDF readers.

Click **Prepare form** again when you're done, then save.
