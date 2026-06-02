# Editor Interaction Rules

This POC explores a Typora-like Markdown editor where users edit and preview in
the same surface. Markdown source remains the document truth, while rendered
elements are a view state.

## Core Model

- Markdown elements have two view states: `Rendered` and `Editing`.
- `Rendered` is for reading and navigation.
- `Editing` exposes Markdown source for the active element.
- View-state transitions do not change document content.
- Only actual text mutations are recorded in undo history.

## Editing Entry

- If a collapsed cursor enters a rendered element, open that element in
  `Editing`.
- Clicking a rendered element opens only that element in `Editing`.
- Pressing `Backspace` immediately after a rendered element opens that element
  in `Editing` and does not delete text.
- Pressing `Delete` immediately before a rendered element opens that element in
  `Editing` and does not delete text.
- Direction-key movement into a rendered element opens the target element in
  `Editing`.

## Deletion And Input

- With a collapsed cursor, deletion is allowed only after the target element is
  already in `Editing`.
- The first `Backspace` or `Delete` against a rendered element is an open action,
  not a delete action.
- With a non-collapsed selection, deletion and input are immediate:
  - first resolve the selection to source ranges,
  - open affected elements in `Editing`,
  - apply the delete or input in the same user action.
- This selection exception prevents selected text from requiring an extra delete
  key press.

## Selection

- While a selection is non-collapsed, automatic rerendering is suspended.
- A partial selection inside a rendered element maps to that element's content
  range only.
- Selecting all visible text of an element from inside the element still maps to
  the content range only.
- Wrapper tokens are included only when the selection crosses the element
  boundary, such as selecting from outside text into or past the element.
- If a selection crosses multiple rendered elements, all crossed elements are
  opened in `Editing`, and the source selection range is preserved.

Examples:

```md
**[bold]**   // content selection; formatting remains
[**bold**]   // boundary-crossing selection; formatting can be removed
```

## Rerendering

- When the cursor leaves an editing element and the selection is collapsed, fold
  the element back to `Rendered`.
- Pressing `Esc` folds the active element if its Markdown is valid.
- Leaving an element without changes silently folds it back.
- Invalid Markdown does not fold. It stays visible as source text until it
  becomes valid again.

## Composition And History

- Do not open, fold, or rerender elements during IME composition.
- Resume parsing after `compositionend`, preferably on the next microtask or
  animation frame.
- `Rendered`/`Editing` transitions are view state and must not enter undo
  history.
- If selection deletion opens elements and mutates text in one user action, only
  the text mutation is one undo step.

## Element Policies

- Bold, italic, strikethrough, and inline code follow the normal element-level
  rules.
- Inline code content is not parsed as Markdown while rendered or editing.
- Links open in `Editing` on normal click and should expose `[text](url)`.
- Links may use `Ctrl+Click` or a separate affordance to open the target URL.
- Images follow Markdown viewer semantics as inline elements. A standalone image
  line may visually occupy its own line, but it uses the normal inline editing
  model. While editing, the image exposes its original `![alt](url)` Markdown
  source in place, just like other source-backed inline elements.
- Local image insertion always stores a Markdown path relative to the document.
  If the image is already inside the project, keep it in place and normalize the
  path. If it is outside the project, copy it into a sibling `assets/` directory
  first. Unsaved documents must be saved before local image insertion can become
  permanent.
- Headings follow the normal rules. An empty heading may remove its marker on the
  second `Backspace`.
- Blockquotes follow the normal line-level element rules and expose the `>`
  marker while editing.
- Horizontal rules follow the normal line-level element rules and expose their
  marker text while editing.
- Lists are line-level elements. While editing, the source marker is exposed in
  place. `Enter` continues the list, `Enter` on an empty item exits the list,
  `Shift+Enter` inserts an indented continuation line inside the current item,
  and `Tab` / `Shift+Tab` adjust indentation.
- Code block contents remain plain text. Markdown inside fenced code blocks is
  never rendered.
- Tables are block elements. Rendered tables are visual previews only; editing
  exposes the raw Markdown table source. Cell-level editing, row/column controls,
  and width resizing are out of scope for the base interaction model.
- Nested inline elements are out of scope for the first POC. If encountered,
  prefer opening the innermost leaf element or treating the nested inline span as
  one editing range.
- Adjacent rendered elements need an explicit boundary slot:
  - `Backspace` at the boundary opens the left element,
  - `Delete` at the boundary opens the right element,
  - pointer hit-testing chooses the closest element.

## Visual Feedback

- Markdown wrapper tokens are shown in a muted color while editing.
- The active editing element gets a subtle background highlight.
- Opening an element with `Backspace` or `Delete` preserves the caret at the
  boundary the user acted on.
- Rendering and editing should avoid line-height jumps where possible.
