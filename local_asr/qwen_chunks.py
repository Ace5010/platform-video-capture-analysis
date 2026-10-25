"""Complete, bounded chunk recovery for the installed Qwen3 native runner."""
import re
import time


def compact_hints(vocabulary, context):
    """Keep relevant spellings, without copying long descriptions into ASR."""
    topic = ' '.join(str((context or {}).get(key) or '') for key in ('title', 'description'))
    terms = []
    for term in vocabulary or []:
        if re.search(r'(?<![A-Za-z0-9])' + re.escape(term) + r'(?![A-Za-z0-9])', topic, re.I):
            terms.append(term)
        if len(terms) >= 16:
            break
    title = re.sub(r'https?://\S+', '', str((context or {}).get('title') or '')).split('#')[0][:100]
    return terms, '中文口播，涉及人工智能及软件。术语仅供参考，以实际音频为准。' + title


class HintEchoError(RuntimeError):
    pass


def echoes_hints(text, vocabulary, prompt):
    """Flag copied hint material for acoustic re-recognition, never text editing."""
    normalize = lambda value: re.sub(r'[\W_]+', '', str(value).casefold())
    output = normalize(text)
    terms = [normalize(term) for term in vocabulary or []]
    # A contiguous run of six supplied spellings is strong prompt-copy evidence.
    if any(''.join(terms[i:i+6]) in output for i in range(max(0, len(terms)-5))):
        return True
    if 3 <= len(terms) <= 5 and len(''.join(terms)) >= 16 and ''.join(terms) in output:
        return True
    if not prompt:
        return False
    context = normalize(prompt)
    if any(normalize(marker) in output for marker in ('术语仅供参考', '以实际音频为准', '本视频主题信息')):
        return True
    # Long descriptions can be copied without triggering native truncation.
    return any(context[i:i+60] in output for i in range(max(0, len(context)-59)))


def run_with_hint_recovery(run, samples, vocabulary, prompt, compact, retry_errors, recoveries):
    """A budget/repetition error can be caused by prompt copying, not speech density."""
    modes = [('full', vocabulary, prompt), ('compact', *compact), ('terms_only', compact[0], None),
             ('unhinted', None, None)]
    if not vocabulary and not prompt:
        modes = [('unhinted', None, None)]
    for index, (mode, terms, context) in enumerate(modes):
        try:
            result = run(samples, terms, context)
            if echoes_hints(getattr(result, 'text', ''), terms, context):
                error = HintEchoError('模型输出复述了识别提示，需要重新识别原始音频')
                error.partial_result = result
                raise error
            if index:
                recoveries.append({'strategy': 'hint_recovery', 'status': 'complete', 'hint_mode': mode,
                                   'vocabulary_count': len(terms or []), 'prompt_characters': len(context or '')})
            return result
        except (*retry_errors, HintEchoError) as error:
            partial = getattr(error, 'partial_result', None)
            recoveries.append({'strategy': 'hint_recovery', 'status': 'failed', 'hint_mode': mode,
                               'error_type': type(error).__name__, 'partial_text': str(getattr(partial, 'text', ''))[:300]})
            if isinstance(error, HintEchoError) or echoes_hints(getattr(partial, 'text', ''), terms, context):
                raise HintEchoError('检测到提示词污染，需要整条音轨无提示重识别') from error
            if index == len(modes)-1:
                raise


def transcribe_audio(run, pcm, window_samples, vocabulary, prompt, compact, retry_errors, recoveries,
                     sample_rate=16000):
    """Discard every hinted row after echo evidence; restart the complete audio."""
    active_terms, active_prompt = vocabulary, prompt
    while True:
        rows = []; start = 0
        try:
            while start < len(pcm):
                end = next_chunk_end(pcm, start, window_samples, sample_rate=sample_rate)
                def recognize(samples):
                    return run_with_hint_recovery(run, samples, active_terms, active_prompt, compact,
                                                  retry_errors, recoveries)
                rows.extend(transcribe_chunk(recognize, pcm, start, end, retry_errors=retry_errors,
                                             recoveries=recoveries, sample_rate=sample_rate))
                start = end
            return rows, not active_terms and not active_prompt
        except HintEchoError:
            if not active_terms and not active_prompt:
                raise
            recoveries.append({'strategy': 'whole_audio_hint_reset', 'status': 'restarted',
                               'discarded_chunks': len(rows), 'at_seconds': start/sample_rate})
            active_terms, active_prompt = None, None


def next_chunk_end(pcm, start, window_samples, sample_rate=16000):
    end = min(len(pcm), start + window_samples)
    if end < len(pcm):
        # Keep the existing quiet cut, then avoid leaving a subsecond tail.
        step = max(1, sample_rate // 20)
        candidates = range(max(start + sample_rate, end - 2 * sample_rate), end - step, step)
        if candidates:
            end = min(candidates, key=lambda k: sum(x*x for x in pcm[k:k+2*step])) + step
        if 0 < len(pcm) - end < sample_rate:
            end = len(pcm) - sample_rate
    if end <= start:
        raise ValueError('音频分段边界无效')
    return end


def transcribe_chunk(run, pcm, start, end, *, retry_errors, recoveries, sample_rate=16000, depth=0):
    """Re-run only an incomplete range. Samples are never omitted or repeated."""
    began = time.perf_counter()
    try:
        result = run(pcm[start:end])
    except retry_errors as error:
        recoveries.append({'error_type': type(error).__name__, 'start_seconds': start/sample_rate,
                           'end_seconds': end/sample_rate, 'seconds': time.perf_counter()-began,
                           'depth': depth})
        if depth >= 3 or end-start < 4*sample_rate:
            partial = getattr(error, 'partial_result', None)
            error.failed_range = {'start_seconds': start/sample_rate, 'end_seconds': end/sample_rate,
                                  'depth': depth, 'partial_text': str(getattr(partial, 'text', ''))[:300]}
            error.recovery_trace = recoveries[-20:]
            raise
        middle = (start+end)//2
        left = transcribe_chunk(run, pcm, start, middle, retry_errors=retry_errors,
                                recoveries=recoveries, sample_rate=sample_rate, depth=depth+1)
        right = transcribe_chunk(run, pcm, middle, end, retry_errors=retry_errors,
                                 recoveries=recoveries, sample_rate=sample_rate, depth=depth+1)
        return left+right
    return [{'start': start, 'end': end, 'result': result, 'seconds': time.perf_counter()-began}]
