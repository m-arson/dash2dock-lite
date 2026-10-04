import sys
import re

from os import listdir, mkdir, makedirs
from os.path import isdir, isfile, join, exists, dirname, normpath
from shutil import copyfile, copytree, rmtree
from pprint import pprint

imports = []

def modifyMetadata():
    metadata = open("./metadata.json", "r").read()
    metadata = re.sub(
        r'"shell-version":\s*\[[^\]]*\]',
        '"shell-version": ["42", "43", "44"]',
        metadata,
    )
    open("./build/metadata.json", "w").write(metadata)

def moduleExpr(source, f):
    """Legacy imports expression for an ES module source"""
    gi = re.match(r"gi://([A-Za-z0-9]+)(\?version=(.+))?$", source)
    if gi:
        name = gi.group(1)
        if name == "cairo":
            return "imports.cairo"
        if gi.group(3):
            return f"(imports.gi.versions.{name} = '{gi.group(3)}', imports.gi.{name})"
        return f"imports.gi.{name}"

    shell = re.match(r"resource:///org/gnome/shell/((ui|misc)/.+)\.js$", source)
    if shell:
        return "imports." + shell.group(1).replace("/", ".")

    if source.startswith("."):
        # resolve relative to the importing file, within the extension
        path = normpath(join(dirname(f), source))
        return "Me.imports." + path[: -len(".js")].replace("/", ".")

    return None

def convertImport(statement, f):
    m = re.match(r"import\s*(.*?)\s*from\s*'([^']+)';?$", statement)
    if not m:
        return statement
    spec, source = m.group(1), m.group(2)

    # base classes provided by gnome-shell 45+; legacy init() is in tools/imports_*.js
    if source.endswith("/extensions/extension.js"):
        return "class Extension {}"
    if source.endswith("/extensions/prefs.js"):
        return "class ExtensionPreferences {}"
    # dock.js and animator.js import each other; inline the constants
    if re.match(r"\{\s*DockPosition\s*\}$", spec):
        return "const DockPosition = {BOTTOM: 'bottom',LEFT: 'left',RIGHT: 'right',TOP: 'top'};"
    if source == "gi://GioUnix":
        return ""

    expr = moduleExpr(source, f)
    if expr is None:
        return statement

    if spec.startswith("{"):
        names = [n.strip() for n in spec.strip("{} ").split(",") if n.strip()]
        names = [re.sub(r"^(\w+)\s+as\s+(\w+)$", r"\1: \2", n) for n in names]
        return f"const {{ {', '.join(names)} }} = {expr};"

    name = re.sub(r"^\*\s*as\s+", "", spec)
    return f"const {name} = {expr};"

def dump(f):
    if not f.endswith(".js"):
        return
    if "build/" in f:
        return
    if "tests/" in f:
        return
    if "imports_" in f:
        return
    f = f.strip()
    of = f.replace("./", "./build/")

    output = open(of, "w")

    output.write("const ExtensionUtils = imports.misc.extensionUtils;\n")
    output.write("const Me = ExtensionUtils.getCurrentExtension();\n\n")

    inImport = False;
    importLine = ""
    for l in open(f, "r"):
        commentOut = False

        if "this.getSettings(schemaId)" in l:
            l = l.replace("this.getSettings", "ExtensionUtils.getSettings");

        if l.startswith("import ") and not inImport:
            # commentOut = True
            inImport = True

        if inImport:
            importLine = importLine + l.strip();

        if l.startswith("export default"):
            l = l.replace("export default", "")
        if l.startswith("export "):
            # only var declarations are visible to legacy Me.imports
            l = re.sub(r"^export (const|let) ", "var ", l)
            l = l.replace("export ", "")

        if commentOut:
            output.write("//")

        if not inImport:
            output.write(l);

        if inImport and "from" in l:
            output.write(convertImport(importLine, f))
            output.write("\n")

            inImport = False
            importLine = ""

    if "prefs.js" in f:
        for l in open("./tools/imports_prefs.js", "r"):
            output.write(l)
    if "extension.js" in f:
        for l in open("./tools/imports_extension.js", "r"):
            output.write(l)

    output.write("\n\n")


def dumpFiles(path):
    morePaths = []

    files = listdir(path)
    for f in files:
        fullpath = join(path, f)

        if isdir(fullpath):
            morePaths.append(fullpath)
            continue

        dump(fullpath)

    for p in morePaths:
        dumpFiles(p)

dumpFiles("./")
modifyMetadata()
