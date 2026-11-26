# The demo: show what this change does

The engine shows every mutant to people (the owner, the lab, the PR) as annotated before/after screenshots and a
captioned video of its main flow. It does this by running your demo against the deployed mutant AND against its
parent (the "before"), so the same steps must make sense on both: start from pages that already exist.

Write it as JSON:

```json
{
  "shots": [
    {
      "name": "Design panel on the generator",
      "path": "/",
      "viewport": "desktop",
      "steps": [{ "action": "fill", "target": "#url", "value": "https://example.com" }],
      "marks": [{ "target": "[data-test=design-panel]", "label": "New: colours, shapes and logo" }],
      "caption": "One sentence on what a person sees here."
    }
  ],
  "flow": {
    "name": "Make a branded QR code",
    "path": "/",
    "viewport": "desktop",
    "steps": [
      { "action": "fill", "target": "#url", "value": "https://example.com", "caption": "Type a link" },
      { "action": "click", "target": "text=Colours", "caption": "Open the new design panel" },
      { "action": "click", "target": "[data-swatch=navy]", "caption": "Pick a colour: the preview updates" },
      { "action": "wait", "value": 800 }
    ]
  }
}
```

Rules:
- 1–4 shots of exactly the screens your change affects, in the state where the change is visible (open the panel,
  fill the form, show the result). Not the untouched home page. Each shot's marks point at the changed elements
  (1–3 marks, short labels). Add one `"viewport": "mobile"` shot if the change matters on phones.
- One flow: the task a person does with this change, start to finish, 3–15 steps, each with a short caption
  saying what happens and why it matters. It is recorded as a video.
- Actions: goto (value = path), click, fill, select, check, hover, press (value = key), scroll (target or value
  = pixels), wait (value = ms). No uploads.
- Targets are Playwright selectors: prefer stable ones (`#id`, `[data-…]`, `role=button[name="Save"]`,
  `text=Exact label`). Make sure they match exactly one visible element.
- Only public pages; no sign-in, no real payments, no real emails. Invent example data.
- For a change that is mostly visual (a redesign), the shots are the key screens and the flow is the core task
  on the new design.
