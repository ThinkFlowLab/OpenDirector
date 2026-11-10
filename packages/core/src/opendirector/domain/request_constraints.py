"""Check explicit constraints against transmitted roles and parameters."""
from math import isclose

from opendirector.domain.omni_capabilities import RequestConstraints


INPUT_ROLES = frozenset({'text', 'image', 'video', 'audio', 'instructions', 'voice',
    'reference_audio', 'reference_text', 'reference_embedding', 'speaker_embedding', 'mask_image', 'reference_image',
    'first_frame', 'last_frame'})


def constraint_failure(contract: RequestConstraints, counts: dict[str, int] | None, parameters: dict):
    """Return a localizable cause and arguments. Missing facts impose no limit."""
    if counts is not None:
        for role, constraint in contract.inputs.items():
            if role not in INPUT_ROLES:
                continue
            count = counts.get(role, 0)
            if count and constraint.support == 'unsupported':
                return 'input_unsupported', {'input': role}
            if constraint.min_count is not None and count < constraint.min_count:
                return 'required_inputs_missing', {'input': role, 'minimum': constraint.min_count, 'actual': count}
            if constraint.max_count is not None and count > constraint.max_count:
                return 'input_count_exceeded', {'input': role, 'maximum': constraint.max_count, 'actual': count}
        for group in contract.required_any_of:
            if set(group) <= INPUT_ROLES and not any(counts.get(role, 0) for role in group):
                return 'required_inputs_missing', {'inputs': group}
    width, height = parameters.get('width'), parameters.get('height')
    if (contract.max_output_pixels is not None and type(width) is int and type(height) is int
            and width * height > contract.max_output_pixels):
        return 'parameter_value_unsupported', {'parameter': 'size'}
    for name, value in parameters.items():
        constraint = contract.parameters.get(name)
        if constraint is None or value is None:
            continue
        if constraint.support == 'unsupported':
            return 'parameter_unsupported', {'parameter': name}
        if constraint.enum is not None and not any(isinstance(value, bool) == isinstance(option, bool) and value == option
                                                  for option in constraint.enum):
            return 'parameter_value_unsupported', {'parameter': name}
        numeric = type(value) in {int, float}
        if ((constraint.type == 'integer' and type(value) is not int)
                or (constraint.type == 'number' and not numeric)
                or (constraint.type == 'boolean' and type(value) is not bool)
                or (constraint.type == 'string' and not isinstance(value, str))):
            return 'parameter_value_unsupported', {'parameter': name}
        if numeric:
            if ((constraint.minimum is not None and value < constraint.minimum)
                    or (constraint.maximum is not None and value > constraint.maximum)
                    or (constraint.step is not None and not isclose(value / constraint.step, round(value / constraint.step), abs_tol=1e-8))):
                return 'parameter_value_unsupported', {'parameter': name}
    return None


def input_details(contract):
    if contract is None:
        return []
    details = [dict(name=name, support=value.support, source='service', minCount=value.min_count,
                    maxCount=value.max_count) for name, value in contract.inputs.items()]
    details.extend(dict(name=name, support=value.support, source='service', values=value.enum,
                        min=value.minimum, max=value.maximum, multipleOf=value.step)
                   for name, value in contract.parameters.items())
    if contract.max_output_pixels is not None:
        details.append(dict(name='output_pixels', support='supported', source='service', max=contract.max_output_pixels))
    return details
