# Ingest prompt

Sent as `instructions` on the Responses API call in
`markdownFromDocument()` (`frontend/lib/openai.ts`). Verbatim from the spec:

> Convert this document to clean, faithful Markdown. Use `#`/`##`/`###`
> headings to reflect the document's structure. Wrap key concepts and named
> entities in `[[double brackets]]`, and add `[[wikilinks]]` between clearly
> related topics. Do not invent content. Output only Markdown, no commentary.

## Input paths

The spec says "OpenAI file input", which accepts PDFs and images but not Office
formats. So the accepted upload types split three ways:

| Upload | How it reaches the model |
| --- | --- |
| PDF | `input_file` with a base64 data URI — the model sees layout and images |
| DOCX, PPTX | Text extracted locally with `officeparser`, sent as `input_text` |
| TXT, MD | Sent as `input_text` |

Extracted Office markdown is passed through `cleanExtractedMarkdown()` first,
which strips the extractor's empty frontmatter block and its Pandoc-style
`{#slug}` heading anchors. Without that the model tends to echo them.

## Output handling

The response is unfenced (a leading ```` ```markdown ```` wrapper is removed if
present) and the title is derived by `deriveTitle()` — first `#` heading,
falling back to the filename. `uniqueTitle()` then disambiguates against the
user's existing titles, because titles are what the graph resolves links
against.
