// ============================================================================
// HTML Generation Rules - Guidelines for generating web applications
// ============================================================================

export const HTML_GENERATION_RULES = `
## HTML/Game/Web Application Generation Rules (CRITICAL)

When generating HTML files, games, or web applications, you MUST follow these rules:

1. **ALWAYS create self-contained single HTML files** that work directly in browser
2. **Include ALL CSS styles inline** in a <style> tag within <head>
3. **Include ALL JavaScript inline** in a <script> tag at the end of <body>
4. **NEVER require Node.js, npm, or any build tools** - the file must work by simply opening in browser
5. **NEVER create separate files** (no separate .css, .js, package.json, vite.config.js, etc.)
6. **Use modern CSS** for styling (flexbox, grid, gradients, shadows, animations)
7. **Make it visually appealing** with proper colors, spacing, and typography
8. **Include responsive design** that works on different screen sizes

## Large File Generation Strategy (防止代码截断) - MANDATORY

**⚠️ CRITICAL: Output length is LIMITED! Large files WILL be truncated if you try to write them in one call!**

When generating applications (games, interactive tools, etc.) estimated to exceed 300 lines:

**YOU MUST USE Multi-step Generation:**
1. **Step 1**: Write SKELETON file with structure only:
   - HTML boilerplate + empty style tag + empty script tag
   - Just the container elements, NO actual logic

2. **Step 2-N**: Use edit_file to ADD content incrementally:
   - Add CSS styles (one edit_file call)
   - Add HTML body content (one edit_file call)
   - Add JS variables and state (one edit_file call)
   - Add each major function separately (multiple edit_file calls)
   - Add event listeners and init code (one edit_file call)

**Example workflow for a game:**
\`\`\`
Step 1: write_file - Create skeleton (50 lines)
Step 2: edit_file - Add CSS styles (replace empty style content)
Step 3: edit_file - Add HTML body elements
Step 4: edit_file - Add game state variables
Step 5: edit_file - Add render/draw function
Step 6: edit_file - Add game logic functions
Step 7: edit_file - Add input handlers
Step 8: edit_file - Add game loop and init
\`\`\`

**DO NOT:**
- Try to write 300+ line files in a single write_file call
- Assume your output won't be truncated
- Write incomplete code and expect it to work

**Truncation Detection:**
If the system warns that your output was truncated:
- The file is BROKEN and needs to be regenerated using multi-step approach
- Start over with the skeleton approach above

Example structure:
\`\`\`html
<!DOCTYPE html>
<html lang="zh">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Title</title>
    <style>
        /* All CSS styles here */
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: system-ui, sans-serif; }
    </style>
</head>
<body>
    <!-- All HTML content -->
    <script>
        // All JavaScript code
    </script>
</body>
</html>
\`\`\`
`;
