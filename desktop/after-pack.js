// electron-builder's own icon step needs a helper download that this machine cannot extract, so the logo
// and version details are written into Pramaan.exe here with rcedit, which ships inside its npm package.
const path = require("path");
const rcedit = require("rcedit");

exports.default = async function afterPack(context) {
  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  await rcedit(exe, {
    icon: path.join(__dirname, "assets", "icon.ico"),
    "version-string": {
      ProductName: "Pramaan",
      FileDescription: "Pramaan DVR/NVR forensic analysis",
      OriginalFilename: "Pramaan.exe",
      InternalName: "Pramaan",
    },
    "file-version": context.packager.appInfo.version,
    "product-version": context.packager.appInfo.version,
  });
  console.log(`  • logo and version details written into ${path.basename(exe)}`);
};
