"""Build the optional example ZIPs and metadata-only discovery catalog."""
import json
from pathlib import Path
import sys
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'packages/core/src'))
from opendirector.agent.plugins import package_files

output = root / 'plugins/examples'
output.mkdir(parents=True, exist_ok=True)
catalog = []
for source in sorted((root / 'packages/agent/plugin-examples').iterdir()):
    if not source.is_dir():
        continue
    manifest, files, digest = package_files(source)
    with ZipFile(output / f'{manifest.id}.zip', 'w') as archive:
        for name, content in sorted(files.items()):
            info = ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, content)
    catalog.append({'manifest': manifest.model_dump(by_alias=True), 'digest': digest,
                    'url': f'https://raw.githubusercontent.com/ThinkFlowLab/OpenDirector/main/plugins/examples/{manifest.id}.zip'})
(root / 'plugins/catalog.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
