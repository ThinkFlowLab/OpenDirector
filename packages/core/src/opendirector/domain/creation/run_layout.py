"""Arrange opted-in Run groups and their contents on the saved canvas."""

from collections import defaultdict
from dataclasses import dataclass
from math import isfinite
from uuid import UUID

from .project import ProjectSnapshot
from .validation import ContractError


_RUN_ROW_WIDTH = 3000
_RUN_GAP = 80
_CONTENT_GAP = 32
_PADDING = 24
_HEADER_HEIGHT = 40


@dataclass(frozen=True)
class _Bounds:
    left: float
    top: float
    right: float
    bottom: float

    @property
    def width(self):
        return self.right - self.left

    @property
    def height(self):
        return self.bottom - self.top

    def translate(self, x, y):
        return _Bounds(self.left + x, self.top + y, self.right + x, self.bottom + y)

    def union(self, other):
        return _Bounds(min(self.left, other.left), min(self.top, other.top),
                       max(self.right, other.right), max(self.bottom, other.bottom))

    def overlaps(self, other, gap):
        return (self.left < other.right + gap and self.right + gap > other.left
                and self.top < other.bottom + gap and self.bottom + gap > other.top)


def _footprint(item, children):
    """Include descendant overflow in the footprint of a group moved as a unit."""
    bounds = _Bounds(0, 0, item['width'], item['height'])
    pending = [item]
    origins = {item['id']: (0, 0)}
    while pending:
        parent = pending.pop()
        x, y = origins[parent['id']]
        for child in children.get(parent['id'], ()):
            child_x = x + child['position']['x']
            child_y = y + child['position']['y']
            origins[child['id']] = (child_x, child_y)
            bounds = bounds.union(_Bounds(child_x, child_y, child_x + child['width'], child_y + child['height']))
            pending.append(child)
    return bounds


def _pack(items, fixed, *, left, top, right, gap):
    """Pack in input order around fixed bounds. A wide item gets its own row."""
    x, y, row_bottom = left, top, top
    for item, footprint in items:
        row_limit = max(right, left + footprint.width)
        blocker_bottom = None
        while True:
            if x + footprint.width > row_limit:
                # A nonempty row wraps below its tallest item. An empty row
                # that hit fixed objects skips to the first possible opening.
                bottom = row_bottom if row_bottom > y else blocker_bottom
                if bottom is None or not isfinite(bottom + gap) or bottom + gap <= y:
                    raise ContractError('canvas_run_layout_extent', '坐标或尺寸超出可排列范围，请缩小相关节点。', UUID(item['id']))
                y = bottom + gap
                x, row_bottom, blocker_bottom = left, y, None
            candidate = _Bounds(x, y, x + footprint.width, y + footprint.height)
            if (not isfinite(candidate.right) or not isfinite(candidate.bottom)
                    or candidate.right <= x or candidate.bottom <= y):
                raise ContractError('canvas_run_layout_extent', '坐标或尺寸超出可排列范围，请缩小相关节点。', UUID(item['id']))
            blockers = [bounds for bounds in fixed if candidate.overlaps(bounds, gap)]
            if not blockers:
                break
            x = max(bounds.right for bounds in blockers) + gap
            nearest_bottom = min(bounds.bottom for bounds in blockers)
            blocker_bottom = nearest_bottom if blocker_bottom is None else min(blocker_bottom, nearest_bottom)
        item['position'] = {'x': x - footprint.left, 'y': y - footprint.top}
        x = candidate.right + gap
        row_bottom = max(row_bottom, candidate.bottom)


def _positioned(item, footprint):
    position = item['position']
    return footprint.translate(position['x'], position['y'])


def _layout_contents(run, children):
    items = [(child, _footprint(child, children)) for child in children.get(run['id'], ())]
    fixed = [_positioned(child, bounds) for child, bounds in items if child['locked']]
    movable = [(child, bounds) for child, bounds in items if not child['locked']]
    # Decide width before packing. Widening afterwards would change wrapping
    # the next time the same canvas is laid out.
    run['width'] = max(run['width'], max((bounds.right + _PADDING for bounds in fixed), default=0),
                       max((bounds.width + 2 * _PADDING for _, bounds in movable), default=0))
    _pack(movable, fixed, left=_PADDING, top=_HEADER_HEIGHT, right=run['width'] - _PADDING,
          gap=_CONTENT_GAP)
    content_bottom = max((_positioned(child, bounds).bottom for child, bounds in items), default=0)
    run['height'] = max(_HEADER_HEIGHT, content_bottom) + _PADDING


def layout_runs(data: dict):
    """Reflow visible, unlocked Run groups before calculating object revisions."""
    children = defaultdict(list)
    for item in data['canvasItems']:
        if item['visible']:
            children[item['parentId']].append(item)

    runs, fixed, locked_runs = [], [], []
    for item in children[None]:
        if item['kind'] == 'group' and item.get('autoLayout') == 'run' and not item['locked']:
            _layout_contents(item, children)
            runs.append((item, _footprint(item, children)))
        else:
            bounds = _positioned(item, _footprint(item, children))
            if item.get('autoLayout') == 'run':
                for other, other_bounds in locked_runs:
                    if bounds.overlaps(other_bounds, 0):
                        raise ContractError('canvas_run_layout_conflict', '已锁定的 Run 区域重叠，请解锁其中一个后重试。',
                                            UUID(item['id']), related_object_id=UUID(other['id']))
                locked_runs.append((item, bounds))
            fixed.append(bounds)
    _pack(runs, fixed, left=0, top=0, right=_RUN_ROW_WIDTH, gap=_RUN_GAP)


def _validate_membership(canvas, managed, original):
    items = {item['id']: item for item in canvas}
    locked = {run_id for run_id in managed if items[run_id]['locked'] and original.get(run_id, {}).get('locked')}
    if len(managed) < 2 and not locked:
        return
    owners = {}
    for item in canvas:
        root = item
        while root['parentId'] is not None:
            root = items[root['parentId']]
        run_id = root['id']
        if run_id not in managed:
            continue
        previous = original.get(item['id'])
        if run_id in locked and item is not root and (previous is None
                or previous['parentId'] != item['parentId'] or (item['visible'] and not previous['visible'])):
            raise ContractError('role_restricted', '所属 Run 已锁定，请解锁后再加入或显示节点。', UUID(run_id))
        binding = item['binding']
        references = list(item.get('editors', ()))
        if binding['role'] in {'generation', 'editor'}:
            references.append(binding['objectRef'])
        elif binding['role'] == 'empty' and binding.get('draftSpec'):
            references.append(binding['draftSpec'])
        for reference in references:
            owner = owners.setdefault(reference['id'], run_id)
            if owner != run_id:
                raise ContractError('canvas_run_layout_shared_object', '两个 Run 使用了同一个可编辑对象。请复制配置或编辑文档后重试。',
                                    UUID(run_id), related_object_id=UUID(owner))


_LAYOUT_FIELDS = ('position', 'width', 'height', 'parentId', 'visible', 'locked', 'autoLayout')


def reflow_runs(before: ProjectSnapshot, edited: ProjectSnapshot, *, force=False) -> tuple[ProjectSnapshot, set[UUID]]:
    managed = {str(item.id) for item in edited.canvasItems if item.kind == 'group' and item.autoLayout == 'run'}
    if not managed:
        return edited, set()
    canvas = [item.model_dump(mode='json') for item in edited.canvasItems]
    original = {str(item.id): item.model_dump(mode='json') for item in before.canvasItems}
    _validate_membership(canvas, managed, original)
    if (not force and len(canvas) == len(original)
            and all(item['id'] in original and all(
                item.get(field) == original[item['id']].get(field) for field in _LAYOUT_FIELDS
            ) for item in canvas)):
        return edited, set()

    geometry = [(item['position'], item['width'], item['height']) for item in canvas]
    layout_runs({'canvasItems': canvas})
    derived = set()
    for item, prior_geometry in zip(canvas, geometry, strict=True):
        if (item['position'], item['width'], item['height']) == prior_geometry:
            continue
        identity = item['id']
        derived.add(UUID(identity))
        previous = original.get(identity)
        if previous is not None:
            item['revision'] = previous['revision']
            if item != previous:
                item['revision'] += 1
    if not derived:
        return edited, derived
    return ProjectSnapshot.model_validate({**edited.model_dump(), 'canvasItems': canvas}), derived
