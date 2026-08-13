const XTERM_MODULE_SUFFIX = "/@xterm/xterm/lib/xterm.mjs";
const XTERM_KEY_CODE_ASSIGNMENT = "o.toString=s;";
const SAFE_KEY_CODE_DEFINITION =
  `Object.defineProperty(o,"toString",{value:s,configurable:true,writable:true});`;

function isXtermModule(id) {
  const normalized = id.split("?", 1)[0].replaceAll("\\", "/");
  return normalized.endsWith(XTERM_MODULE_SUFFIX);
}

export function transformXtermForFrozenPrototype(code, id) {
  if (!isXtermModule(id)) return null;

  const occurrences = code.split(XTERM_KEY_CODE_ASSIGNMENT).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `xterm frozen-prototype compatibility expected one key-code assignment, found ${occurrences}`,
    );
  }

  return {
    code: code.replace(XTERM_KEY_CODE_ASSIGNMENT, SAFE_KEY_CODE_DEFINITION),
    map: null,
  };
}

export function xtermFreezePrototypeCompat() {
  return {
    name: "xterm-freeze-prototype-compat",
    enforce: "pre",
    transform: transformXtermForFrozenPrototype,
  };
}
