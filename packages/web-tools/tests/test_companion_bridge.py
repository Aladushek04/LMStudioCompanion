import pytest

from webtools import companion_bridge as bridge


async def test_native_image_uses_explicit_model_and_returns_only_evidence(monkeypatch):
    seen = {}

    class Vision:
        def __init__(self, url, *, model_id):
            seen.update(url=url, model=model_id)

        async def aclose(self):
            seen['closed'] = True

    class Visual:
        def __init__(self, fetcher, browser, vision):
            pass

        async def inspect_image(self, url, question):
            return {'schema_version': 2, 'pixels_sent': True, 'interpretation': 'blue square'}, object()

    monkeypatch.setattr(bridge, 'VisionClient', Vision)
    monkeypatch.setattr(bridge, 'VisualTools', Visual)
    result = await bridge.execute({'name':'inspect_image','args':{'url':'https://example.org/image.png','question':'Что видно?'},'search_url':'http://127.0.0.1:8088','vision_model':'selected-12b'})
    assert result['pixels_sent'] is True
    assert result['interpretation'] == 'blue square'
    assert seen == {'url':'http://127.0.0.1:1234','model':'selected-12b','closed':True}


async def test_native_image_refuses_implicit_model_selection():
    with pytest.raises(ValueError, match='модель'):
        await bridge.execute({'name':'inspect_image','args':{},'search_url':'http://127.0.0.1:8088'})
