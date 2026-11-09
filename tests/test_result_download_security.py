"""Unconfigured result hosts cannot turn a completed image call into SSRF."""
import asyncio
import socket

import httpx
import pytest

from opendirector.domain.capabilities import ImageRequest
from opendirector.domain.generation import GenerationError
from opendirector.integrations.model_adapters import OpenAIImages
from opendirector.integrations.providers import GenerationProviders
from test_openai_images import CONFIG, png


@pytest.fixture
def resolve(monkeypatch):
    calls = []
    addresses = ['93.184.216.34']

    def lookup(host, port, **kwargs):
        calls.append(host)
        return [(socket.AF_INET6 if ':' in address else socket.AF_INET,
                 socket.SOCK_STREAM, 6, '', (address, port)) for address in addresses]

    monkeypatch.setattr(socket, 'getaddrinfo', lookup)
    return addresses, calls


def image_from(url, responder=None):
    calls = []

    def handle(request):
        calls.append(request)
        if request.method == 'POST':
            return httpx.Response(200, json={'data': [{'url': url}]})
        return responder(request) if responder else httpx.Response(200, content=png())

    adapter = OpenAIImages(httpx.MockTransport(handle))
    return adapter, calls


def generate(adapter, config=CONFIG):
    return asyncio.run(adapter.image(config, ImageRequest(prompt='edit', width=64, height=48)))


@pytest.mark.parametrize('url', [
    'http://127.0.0.1:8019/private', 'http://127.1/private',
    'http://localhost:8019/private', 'http://LOCALHOST./private',
    'http://10.0.0.1/private', 'http://172.16.0.1/private',
    'http://192.168.1.1/private', 'http://169.254.169.254/latest/meta-data',
    'http://100.64.0.1/private', 'http://0.0.0.0/private',
    'http://224.0.0.1/private', 'http://[::1]/private',
    'http://[fc00::1]/private', 'http://[fe80::1]/private',
    'http://[::ffff:127.0.0.1]/private', 'file:///private.png',
    'https://user:password@cdn.test/private',
    'https://cdn.test:bad/result.png',
])
def test_unconfigured_local_result_is_rejected_before_any_get(url, resolve):
    # Noncanonical numeric hosts and local aliases must be checked after DNS too.
    resolve[0][:] = ['127.0.0.1']
    adapter, calls = image_from(url)
    with pytest.raises(GenerationError) as error:
        generate(adapter)
    assert (error.value.details.stage, error.value.details.category) == ('download', 'protocol')
    assert [call.method for call in calls] == ['POST']


@pytest.mark.parametrize('addresses', [
    ['127.0.0.1'], ['169.254.169.254'], ['::1'], ['::ffff:192.168.1.1'],
    ['93.184.216.34', '10.0.0.1'], [],
])
def test_dns_names_and_mixed_answers_cannot_hide_private_addresses(resolve, addresses):
    resolve[0][:] = addresses
    adapter, calls = image_from('https://cdn.test/result.png')
    with pytest.raises(GenerationError):
        generate(adapter)
    assert len(calls) == 1


def test_public_download_pins_checked_ip_and_preserves_host_tls_and_signed_path(resolve):
    adapter, calls = image_from('https://cdn.test/result.png?signature=keep%2Bme')
    assert generate(adapter).data == png()
    post, download = calls
    assert post.headers['authorization'] == f"Bearer {CONFIG['apiKey']}"
    assert str(download.url) == 'https://93.184.216.34/result.png?signature=keep%2Bme'
    assert download.headers['host'] == 'cdn.test'
    assert download.extensions['sni_hostname'] == 'cdn.test'
    assert 'authorization' not in download.headers
    assert resolve[1] == ['cdn.test']  # No second, unchecked DNS lookup to connect.


def test_public_ipv6_dns_answer_is_pinned(resolve):
    resolve[0][:] = ['2606:4700:4700::1111']
    adapter, calls = image_from('https://cdn.test/result.png')
    assert generate(adapter).data == png()
    assert calls[1].url.host == '2606:4700:4700::1111'
    assert calls[1].headers['host'] == 'cdn.test'


def test_failed_dns_cannot_fall_back_to_an_unchecked_request(monkeypatch):
    def failed(*args, **kwargs):
        raise socket.gaierror('resolver unavailable')

    monkeypatch.setattr(socket, 'getaddrinfo', failed)
    adapter, calls = image_from('https://cdn.test/result.png')
    with pytest.raises(GenerationError) as error:
        generate(adapter)
    assert error.value.details.stage == 'download'
    assert len(calls) == 1


@pytest.mark.parametrize('location', [
    'http://127.0.0.1:8019/private', 'http://[::1]/private', 'https://[broken/result.png',
])
def test_public_redirect_cannot_reach_a_local_service(resolve, location):
    adapter, calls = image_from('https://cdn.test/start',
                               lambda _: httpx.Response(302, headers={'Location': location}))
    with pytest.raises(GenerationError) as error:
        generate(adapter)
    assert error.value.details.stage == 'download'
    assert [call.method for call in calls] == ['POST', 'GET']


def test_relative_public_redirects_are_revalidated_and_have_a_hop_limit(resolve):
    def redirected(request):
        return (httpx.Response(302, headers={'Location': '../final.png'})
                if request.url.path == '/dir/start' else httpx.Response(200, content=png()))

    adapter, calls = image_from('https://cdn.test/dir/start', redirected)
    assert generate(adapter).data == png()
    assert [call.url.path for call in calls[1:]] == ['/dir/start', '/final.png']
    assert resolve[1] == ['cdn.test', 'cdn.test']
    adapter, calls = image_from('https://cdn.test/loop',
                               lambda _: httpx.Response(302, headers={'Location': '/loop'}))
    with pytest.raises(GenerationError):
        generate(adapter)
    assert len(calls) <= 7


def test_explicit_local_origin_keeps_auth_but_a_different_port_is_untrusted(resolve):
    config = {**CONFIG, 'url': 'http://127.0.0.1:9000/v1'}
    adapter, calls = image_from('http://127.0.0.1:9000/result.png')
    assert generate(adapter, config).data == png()
    assert calls[1].headers['authorization'] == f"Bearer {CONFIG['apiKey']}"
    adapter, calls = image_from('http://127.0.0.1:8019/private')
    with pytest.raises(GenerationError):
        generate(adapter, config)
    assert len(calls) == 1


def test_compatible_generation_recovery_uses_the_same_public_host_policy(resolve):
    calls = []
    provider = GenerationProviders(None, httpx.MockTransport(
        lambda request: calls.append(request) or httpx.Response(200, content=png())))
    with pytest.raises(GenerationError):
        asyncio.run(provider.resume_result(CONFIG, 'png', 'http://127.0.0.1:8019/private'))
    assert calls == []
