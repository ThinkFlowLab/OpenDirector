from pathlib import Path

app = Path(defines["app"])
format = "UDZO"
filesystem = "APFS"
files = [str(app)]
symlinks = {"Applications": "/Applications"}

# Keep presentation on the volume. Hiding the app extension adds Finder
# metadata to the signed bundle, which fails strict signature validation.
background = defines["background"]
window_rect = ((150, 150), (700, 410))
icon_locations = {app.name: (190, 147), "Applications": (510, 147)}
icon_size = 90
text_size = 13
show_toolbar = False
show_tab_view = False
show_sidebar = False
show_pathbar = False
show_status_bar = False
