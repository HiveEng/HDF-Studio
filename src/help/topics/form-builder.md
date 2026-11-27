---
title: Building forms
section: Fill and sign
order: 4
keywords: form builder, prepare form, create form, add field, detect fields, fillable, text field, date field, calendar, check box, radio button, dropdown, list box, signature field, button, clear form, calculation, formula, sum, format, currency, zip code, phone, email, required, validation, tab order, align, distribute, same size, duplicate, copy fields, field list, appearance, comb
summary: Turn a flat form into a fillable one, add and arrange fields, set the Tab order, and set formats, calculations and checks.
---
# Building forms

Use **Fill & Sign › Prepare form** ([[Ctrl+Shift+F]]) to add, move and edit form fields. Fields show as outlined boxes with their names while you design. The bar above the page has the field types on the left and the Align, Distribute, Size, Copy and Fields groups on the right.

![Designing a form: the field types and arrange tools across the top, fields outlined on the page](form-designer.png "wide")

When you're done, click **Prepare form** again (or press [[Esc]] with nothing selected), then save.

## Make a flat form fillable automatically

Click **Detect fields**. {{app}} looks for blanks, lines and boxes and suggests fields for them. Review the suggestions on the page, then click **Add** to keep them or **Discard**. Draw any it missed yourself.

## Adding fields

Pick a field type, then drag a box on the page, or click for a standard size:

| Type | Key | Use for |
|---|---|---|
| **Text** | [[T]] | Names, numbers, notes |
| **Date** | [[A]] | Dates. People filling in the form get a calendar. |
| **Check box** | [[C]] | Yes or no |
| **Radio** | [[R]] | One choice from a group. Buttons placed one after another form a group; pick Radio again to start a new group. |
| **Dropdown** | [[D]] | One choice from a list |
| **List** | [[L]] | One or more choices from a visible list |
| **Signature** | [[S]] | Where someone signs |
| **Button** | [[B]] | Clears the form, prints it or opens a web link when clicked |

Dropdowns and lists ask for their choices, separated by commas. Buttons ask for their label and what they do. The **Date field** button on the ribbon and the Ctrl+K palette ("Add a … field") also start each type.

## Selecting and moving fields

- Click a field to select it. [[Shift]]+click or [[Ctrl]]+click adds or removes fields, or drag a box around several.
- [[Ctrl+A]] selects every field on the page in view.
- Drag to move the selected fields together; drag a corner to resize one.
- Arrow keys nudge the selection by one point, or ten with [[Shift]].
- [[Delete]] removes the selection. [[Ctrl+Z]] undoes.

## Lining fields up

Select two or more fields. The **last one you picked** is the anchor that the others line up with or match.

| Group | Buttons |
|---|---|
| **Align** | Left edges, centres across, right edges, top edges, middles down, bottom edges |
| **Distribute** | Space evenly across or down (three or more fields) |
| **Size** | Same width, same height, or both as the anchor. Check boxes and radio buttons stay square. |

## Copying fields

- **Duplicate** ([[Ctrl+D]]) puts a copy just below. [[Ctrl+C]], [[Ctrl+X]] and [[Ctrl+V]] copy, cut and paste, also onto another page.
- **Make copies in rows and columns** builds a table of fields, such as the lines of an order form. Set how many copies down and across and the spacing. Names count on, so *Qty 1* is followed by *Qty 2*, *Qty 3* and so on.
- **Copy to other pages** puts the fields in the same place on the pages you choose, such as `all`, `2-5`, `odd` or `even`.

Copies keep every property of the original, including formats, calculations and default values. A copy of a radio button joins the same group as a new choice.

## Tab order

The Tab key moves through fields in their Tab order. Click **Tab order** (in the bar, or **Fill & Sign › Tab order**) to see a numbered badge on every field, then:

- click the fields in the order you want; radio buttons in one group move together, or
- click **By rows** (left to right, then down) or **By columns** (top to bottom, then across) to order every page at once.

Click **Finish** or press [[Esc]] when done.

## The field list

**Field list** shows every field in the document, page by page, with its Tab position and type. Click a field in the list to select it and scroll to it.

## Field properties

Double-click a field, or select it and press [[Enter]], for its properties. With several fields selected, the changes you make apply to all of them, so you can, for example, make a whole column required or change its font in one go.

| Tab | What you can set |
|---|---|
| **General** | **Name** (used when filling from a spreadsheet and exporting data; radio buttons share a group name), **Tooltip**, **Required** and **Read only** |
| **Appearance** | Border colour and width, fill colour, font, font size (*Auto* fits the box), text alignment and text colour. Check boxes and radio buttons also have the check colour and check style: check, cross, circle, square, diamond or star. |
| **Options** | Default value, **Multiple lines**, **Character limit** and **Comb** (one character per box, for codes and account numbers) for text fields. Choices (one per line) for dropdowns and lists, **Allow typing other text** for dropdowns and **Allow more than one choice** for lists. The value a check box or radio button sends when picked. A button's label. |
| **Format** | Plain text, number, currency, percent or date, with decimal places, currency symbol, number style and negatives in brackets. Also ZIP code, ZIP+4, phone number and Social Security number. |
| **Calculate** | Sum, product, average, minimum or maximum of other fields, or a formula such as `Qty * Price`. |
| **Validate** | A number in a range, or an email address. |
| **Action** | For buttons: clear the form, print, open a web link or do nothing. |

Calculated fields update as people fill in the form, in {{app}} and in other PDF readers.

In a formula, put `\` before a space or a dot in a field name, for example `Qty\ 1 * Price\ 1`.

> **Note:** A copied calculation still uses the same fields as the original. After making copies of a *Total 1* field, open each copy's **Calculate** tab and change the field names (for example to `Qty\ 2 * Price\ 2`).
