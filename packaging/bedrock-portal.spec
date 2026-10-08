# PyInstaller spec for the Bedrock Portal desktop app.
# Build (from the repo root, after `cd frontend && npm run build`):
#     pyinstaller packaging/bedrock-portal.spec --noconfirm
# Output: dist/Bedrock Portal.exe (Windows, single file) or dist/Bedrock Portal.app (macOS).
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

ROOT = Path(SPECPATH).parent  # noqa: F821 - SPECPATH is injected by PyInstaller
BACKEND = ROOT / "backend"
DIST = ROOT / "frontend" / "dist"
if not (DIST / "index.html").exists():
    raise SystemExit("frontend/dist is missing: run `npm ci && npm run build` in frontend/ first.")

datas = [
    (str(DIST), "frontend/dist"),
    (str(ROOT / "infra"), "infra"),
]
datas += collect_data_files("botocore", includes=["data/**/*.json", "data/**/*.json.gz", "cacert.pem"])
datas += collect_data_files("boto3", includes=["data/**/*.json"])

hiddenimports = (
    collect_submodules("app")
    + collect_submodules("uvicorn")
    + ["multipart", "python_multipart", "email.mime.multipart"]
)

block_cipher = None
a = Analysis(  # noqa: F821
    [str(BACKEND / "desktop.py")],
    pathex=[str(BACKEND)],
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "matplotlib", "numpy", "pandas", "PIL", "pytest", "IPython"],
    noarchive=False,
)
pyz = PYZ(a.pure)  # noqa: F821

ICON_WIN = str(ROOT / "packaging" / "icon.ico")
ICON_MAC = str(ROOT / "packaging" / "icon.icns")

if sys.platform == "darwin":
    exe = EXE(  # noqa: F821
        pyz, a.scripts, [], exclude_binaries=True, name="Bedrock Portal", console=False,
        icon=ICON_MAC, argv_emulation=False,
    )
    coll = COLLECT(exe, a.binaries, a.datas, name="Bedrock Portal")  # noqa: F821
    app = BUNDLE(  # noqa: F821
        coll, name="Bedrock Portal.app", icon=ICON_MAC, bundle_identifier="dev.bedrockportal.app",
        info_plist={"CFBundleShortVersionString": "1.0.0", "NSHighResolutionCapable": True,
                    "LSMinimumSystemVersion": "11.0"},
    )
else:
    # Single-file executable: double-click and go.
    exe = EXE(  # noqa: F821
        pyz, a.scripts, a.binaries, a.datas, [],
        name="Bedrock Portal",
        console=False,          # no terminal window
        icon=ICON_WIN,
        upx=False,              # UPX-packed exes trigger more antivirus false positives
        runtime_tmpdir=None,
    )
