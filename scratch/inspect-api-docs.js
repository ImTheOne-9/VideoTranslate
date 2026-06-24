const fs = require('fs');

const filePath = 'C:\\Users\\Admin\\.gemini\\antigravity-ide\\brain\\a743d664-7dcb-4b17-8e45-3dc285db61a6\\.system_generated\\steps\\195\\content.md';
if (!fs.existsSync(filePath)) {
  console.log('File does not exist');
  process.exit(1);
}

const content = fs.readFileSync(filePath, 'utf8');

// Match highlight-line-content
const regex = /class=\\?"highlight-line-content\\?"[^>]*>([\s\S]*?)<\/span>/g;
let match;
const codeLines = [];

while ((match = regex.exec(content)) !== null) {
  let text = match[1]
    .replace(/\\u0026/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\\/g, '')
    .trim();
  codeLines.push(text);
}

console.log('--- Code Block Lines: ---');
console.log(codeLines.join('\n'));
