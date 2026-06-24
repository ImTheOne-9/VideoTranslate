const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'public', 'default_voices');
const destDir = path.join(__dirname, '..', 'uploads', 'voices');

const mapping = {
  'vbee_nu_bac': 'Giọng Nữ miền Bắc',
  'vbee_nam_bac': 'Giọng Nam miền Bắc',
  'vbee_nu_nam': 'Giọng Nữ miền Nam',
  'vbee_nam_nam': 'Giọng Nam miền Nam',
  'vbee_nu_trung': 'Giọng Nữ miền Trung',
  'vbee_nam_trung': 'Giọng Nam miền Trung'
};

function processFolder(dir) {
  if (!fs.existsSync(dir)) return;
  console.log(`Processing folder: ${dir}`);
  
  const files = fs.readdirSync(dir);
  
  // 1. Rename existing files based on mapping
  for (const [oldName, newName] of Object.entries(mapping)) {
    const oldWav = path.join(dir, oldName + '.wav');
    const oldTxt = path.join(dir, oldName + '.txt');
    const newWav = path.join(dir, newName + '.wav');
    const newTxt = path.join(dir, newName + '.txt');

    if (fs.existsSync(oldWav)) {
      fs.renameSync(oldWav, newWav);
      console.log(`Renamed: ${oldName}.wav -> ${newName}.wav`);
    }
    if (fs.existsSync(oldTxt)) {
      fs.renameSync(oldTxt, newTxt);
      console.log(`Renamed: ${oldName}.txt -> ${newName}.txt`);
    }
  }

  // 2. Clean up any leftover vbee_ files if there are any
  const updatedFiles = fs.readdirSync(dir);
  updatedFiles.forEach(file => {
    if (file.startsWith('vbee_')) {
      const p = path.join(dir, file);
      try {
        fs.unlinkSync(p);
        console.log(`Deleted leftover file: ${file}`);
      } catch (err) {
        console.error(`Failed to delete ${file}:`, err.message);
      }
    }
  });
}

processFolder(srcDir);
processFolder(destDir);
console.log('Voice renaming and cleanup completed!');
