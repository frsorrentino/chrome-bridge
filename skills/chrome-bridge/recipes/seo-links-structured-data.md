# SEO, links, structured data
Triggers: "any broken links?", "is the structured data valid?".
`audit({kinds:['links','seo'], save_to:'./audit.md'})`,
`extract({item_selector:'script[type="application/ld+json"]', fields:{json:'text'}})` then validate on
validator.schema.org via `navigate` + `fill_form`.
