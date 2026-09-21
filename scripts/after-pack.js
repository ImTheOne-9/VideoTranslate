const fs = require('fs');
const path = require('path');

const HONGGO_NATIVE_FILES = Object.freeze([
  'tools/crawler/app/honggo_engine/app/capture/fq_oversea/libmetasec_ml.so',
  'tools/crawler/app/honggo_engine/app/capture/fq_oversea/libc++_shared.so'
]);

module.exports = async function afterPack(context) {
  const projectDir = context.packager.projectDir;
  const resourcesDir = path.join(context.appOutDir, 'resources');
  for (const relativePath of HONGGO_NATIVE_FILES) {
    const source = path.join(projectDir, relativePath);
    const destination = path.join(resourcesDir, relativePath);
    if (!fs.existsSync(source) || fs.statSync(source).size <= 0) {
      throw new Error(`Thiếu tài nguyên Honggo bắt buộc: ${relativePath}`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    if (!fs.existsSync(destination) || fs.statSync(destination).size !== fs.statSync(source).size) {
      throw new Error(`Không chép đủ tài nguyên Honggo: ${relativePath}`);
    }
    // NSIS trên một số máy bỏ tệp mang đuôi .so khi nâng cấp. Giữ thêm payload
    // .bin để ứng dụng có thể tái tạo thư viện trước khi bộ ký Java khởi chạy.
    const payloadDirectory = path.join(resourcesDir, 'honggo-native');
    const payload = path.join(payloadDirectory, `${path.basename(relativePath)}.bin`);
    fs.mkdirSync(payloadDirectory, { recursive: true });
    fs.copyFileSync(source, payload);
    if (!fs.existsSync(payload) || fs.statSync(payload).size !== fs.statSync(source).size) {
      throw new Error(`Không chép đủ payload Honggo: ${relativePath}`);
    }
  }
};

module.exports.HONGGO_NATIVE_FILES = HONGGO_NATIVE_FILES;

