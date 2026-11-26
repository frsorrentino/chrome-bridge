# Gutenberg and block editors
Triggers: "write this text in the post", "add a block".
`fill_form` does not reach the block editor. Use `execute_js` with
`wp.data.dispatch('core/block-editor').insertBlocks(wp.blocks.createBlock('core/paragraph',{content}))`
and `wp.data.dispatch('core/editor').savePost()`. Verify with `find_text`.
