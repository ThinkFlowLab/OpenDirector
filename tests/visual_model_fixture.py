"""Loopback wire fixtures for native visual tool calls."""
import base64
from contextlib import contextmanager
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread


def image_bytes(value):
    """Read media payloads at the provider boundary without trusting tool receipts."""
    if isinstance(value, list):
        for part in value:
            yield from image_bytes(part)
    elif isinstance(value, dict):
        if value.get('type') == 'image' and value.get('source', {}).get('type') == 'base64':
            yield base64.b64decode(value['source']['data'], validate=True)
        elif value.get('type') in {'image_url', 'input_image'}:
            url = value['image_url']
            if isinstance(url, dict):
                url = url['url']
            assert url.startswith('data:image/')
            yield base64.b64decode(url.split(',', 1)[1], validate=True)
        else:
            for part in value.values():
                yield from image_bytes(part)


def latest_tool_output(messages):
    for message in reversed(messages):
        if message.get('type') == 'function_call_output':
            return str(message['output'])[:1500]
        if message.get('role') == 'tool':
            return str(message['content'])[:1500]
        content = message.get('content')
        if isinstance(content, list):
            for part in reversed(content):
                if part.get('type') == 'tool_result':
                    result = part.get('content', '')
                    if isinstance(result, list):
                        result = ' '.join(item.get('text', '') for item in result if isinstance(item, dict))
                    return str(result)[:1500]
    return '(no native tool result)'


def stream_events(events):
    return b''.join(
        f"event: {event['type']}\ndata: {json.dumps(event)}\n\n".encode()
        for event in events
    )


def anthropic_stream(index, call, text, model):
    start = dict(type='message_start', message=dict(id=f'msg_{index}', type='message',
        role='assistant', model=model, content=[], usage={'input_tokens': 10, 'output_tokens': 0}))
    if call:
        name, arguments = call
        block = dict(type='tool_use', id=f'toolu_{index}', name=name, input={})
        delta = dict(type='input_json_delta', partial_json=json.dumps(arguments))
    else:
        block = dict(type='text', text='')
        delta = dict(type='text_delta', text=text)
    return stream_events([start, dict(type='content_block_start', index=0, content_block=block),
        dict(type='content_block_delta', index=0, delta=delta), dict(type='content_block_stop', index=0),
        dict(type='message_delta', delta={'stop_reason': 'tool_use' if call else 'end_turn', 'stop_sequence': None},
             usage={'output_tokens': 5}), dict(type='message_stop')])


def responses_stream(index, call, text, model):
    response = dict(id=f'resp_{index}', object='response', status='in_progress', output=[], model=model)
    if call:
        name, arguments = call
        item = dict(id=f'fc_{index}', call_id=f'call_{index}', type='function_call',
                    name=name, arguments=json.dumps(arguments))
        start = dict(item, arguments='', status='in_progress')
        delta = dict(type='response.function_call_arguments.delta', item_id=item['id'],
                     output_index=0, delta=item['arguments'])
    else:
        item = dict(type='message', id=f'msg_{index}', role='assistant',
                    content=[{'type': 'output_text', 'text': text, 'annotations': []}])
        start = dict(item, content=[], status='in_progress')
        delta = dict(type='response.output_text.delta', item_id=item['id'],
                     output_index=0, content_index=0, delta=text)
    item['status'] = 'completed'
    return stream_events([dict(type='response.created', response=response),
        dict(type='response.output_item.added', output_index=0, item=start), delta,
        dict(type='response.output_item.done', output_index=0, item=item),
        dict(type='response.completed', response=dict(response, status='completed', output=[item]))])


@contextmanager
def serve_model(handle):
    class Model(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            status, mime, body = handle(self.path, json.loads(self.rfile.read(int(self.headers['Content-Length']))))
            self.send_response(status)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    with ThreadingHTTPServer(('127.0.0.1', 0), Model) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f'http://127.0.0.1:{server.server_port}'
        finally:
            server.shutdown()
            thread.join(timeout=5)
