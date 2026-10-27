"""Input verification and reasoning configuration are independent dimensions.

These are observations of the installed CodeBuddy channel, not claims about
every API with the same model name. Unknown modalities are never inferred from
a reasoning effort, model name or the CLI's generic supportsImages switch.
"""
from .archive import ArchiveError

CAPABILITIES = {
    'deepseek-v4.1-flash': {'reasoning': True, 'text': True, 'image': True, 'video': False, 'audio': None},
    # The installed product catalog does not declare these reasoning settings.
    # Verified video input is not evidence for a configurable reasoning mode.
    'minimax-m3': {'reasoning': None, 'text': True, 'image': None, 'video': True, 'audio': None},
    'minimax-m3.1-flash': {'reasoning': None, 'text': True, 'image': None, 'video': True, 'audio': None},
    'glm-5.3-flash': {'reasoning': True, 'text': True, 'image': None, 'video': False, 'audio': None},
    'hy4-preview': {'reasoning': True, 'text': True, 'image': None, 'video': None, 'audio': None},
}


def require_input(model, modality):
    supported = CAPABILITIES.get(model, {}).get(modality)
    if supported is not True:
        label = {'image':'图片','video':'完整视频','audio':'音频','text':'文字'}.get(modality,modality)
        raise ArchiveError(f'{model} 的{label}输入尚未通过当前通道验证，已在收费调用前停止')


def input_routes(summary_model):
    require_input(summary_model,'text')
    return {'text':summary_model,'image':summary_model,'video':None,'audio':None}
