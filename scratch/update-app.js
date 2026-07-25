const fs = require('fs');
const path = require('path');

const appJsPath = path.join(__dirname, '..', 'public', 'app.js');
let code = fs.readFileSync(appJsPath, 'utf8');

// 1. In getGlobalAiSettings
if (!code.includes('opencodeModel:')) {
  code = code.replace(
    "ninerouterBaseUrl: localStorage.getItem('global_ninerouter_base_url') || 'http://localhost:20128/v1',",
    "ninerouterBaseUrl: localStorage.getItem('global_ninerouter_base_url') || 'http://localhost:20128/v1',\n    opencodeModel: localStorage.getItem('global_opencode_model') || 'DeepSeek V4 Flash (Free)',"
  );
}

// 2. In getGlobalAiQueryParams
if (!code.includes('&opencodeModel=')) {
  code = code.replace(
    "&ninerouterBaseUrl=${encodeURIComponent(settings.ninerouterBaseUrl)}",
    "&ninerouterBaseUrl=${encodeURIComponent(settings.ninerouterBaseUrl)}&opencodeModel=${encodeURIComponent(settings.opencodeModel)}"
  );
}

// 3. In openGlobalSettingsModal
if (!code.includes('global-opencode-model')) {
  code = code.replace(
    "if (ninerouterInput) {",
    "if ($('global-opencode-model')) { $('global-opencode-model').value = settings.opencodeModel || 'DeepSeek V4 Flash (Free)'; }\n  if (ninerouterInput) {"
  );
}

// 4. In toggleGlobalAiProviderFields
if (!code.includes('global-opencode-fields')) {
  const targetStr = `  if (ninerouterFields) {
    if (val === 'ninerouter') {
      ninerouterFields.classList.remove('hidden');
      const key = $('global-ninerouter-key') ? $('global-ninerouter-key').value : '';
      const baseUrl = $('global-ninerouter-base-url') ? $('global-ninerouter-base-url').value : 'http://localhost:20128/v1';
      loadNineRouterModels(key, baseUrl);
    } else {
      ninerouterFields.classList.add('hidden');
    }
  }`;

  const replacementStr = targetStr + `
  const opencodeFields = $('global-opencode-fields');
  if (opencodeFields) {
    if (val === 'opencode') {
      opencodeFields.classList.remove('hidden');
    } else {
      opencodeFields.classList.add('hidden');
    }
  }`;

  if (code.includes(targetStr)) {
    code = code.replace(targetStr, replacementStr);
  } else if (code.includes(targetStr.replace(/\n/g, '\r\n'))) {
    code = code.replace(targetStr.replace(/\n/g, '\r\n'), replacementStr.replace(/\n/g, '\r\n'));
  }
}

// 5. In saveGlobalSettings
if (!code.includes('global_opencode_model')) {
  code = code.replace(
    "if (ninerouterBaseUrlInput) localStorage.setItem('global_ninerouter_base_url', ninerouterBaseUrlInput.value);",
    "if (ninerouterBaseUrlInput) localStorage.setItem('global_ninerouter_base_url', ninerouterBaseUrlInput.value);\n  const opencodeModelSelect = $('global-opencode-model');\n  if (opencodeModelSelect) localStorage.setItem('global_opencode_model', opencodeModelSelect.value);"
  );
}

fs.writeFileSync(appJsPath, code, 'utf8');
console.log('App.js updated successfully!');
