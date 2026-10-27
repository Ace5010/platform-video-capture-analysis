"""单次、可审计的官方 Buddy CLI 总结；不自动重试付费请求。"""
import argparse
from datetime import datetime, timezone
import json
import os
import re
import hashlib
from pathlib import Path
import subprocess
import time
import uuid
import tempfile

from .archive import ArchiveError
from .summaries import prepare_day, validate_summary, compact_model_messages, repair_summary
from .resources import require_summary_resources, summary_images, missing_resources
from .models import require_input, input_routes
from .media_reading import prepare_media, MediaFailure, credits as media_credits

ROOT = Path(__file__).resolve().parent
from .paths import runtime_root, data_root
RUNTIME = runtime_root()


class SummaryFailure(ArchiveError):
    """A safe explanation plus the original receipt, including incurred usage."""
    def __init__(self, reason, receipt):
        super().__init__(reason)
        self.receipt = receipt


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(temp, path)


def result_record(raw):
    try:
        outer = json.loads(raw)
    except (ValueError, TypeError):
        raise ArchiveError('CLI 返回的执行记录不是有效 JSON') from None
    if isinstance(outer, list):
        results = [item for item in outer if isinstance(item, dict) and item.get('type') == 'result']
        if len(results) != 1:
            raise ArchiveError('CLI 结果事件数量无效')
        outer = results[0]
    if not isinstance(outer, dict):
        raise ArchiveError('CLI 返回格式无效')
    return outer


def parse_result(raw, prepared, reference_map=None):
    outer = result_record(raw)
    if outer.get('is_error') or outer.get('subtype') not in (None, 'success'):
        raise ArchiveError('CLI 未成功完成；已保留执行记录，不自动重试')
    result = outer.get('structured_output') or outer.get('result')
    if isinstance(result, str):
        result = result.strip()
        if result.startswith('```') and result.endswith('```'):
            result = result.split('\n', 1)[1].rsplit('```', 1)[0].strip()
        try:
            result = json.loads(result)
        except ValueError:
            raise ArchiveError('模型返回的总结不是有效 JSON') from None
    result, repairs = repair_summary(result, prepared, reference_map)
    checked = validate_summary(result, prepared)
    for topic in checked['topics']:
        for view in topic['views']:
            if any(prepared['sources'][ref]['speaker'] != view['speaker'] for ref in view['refs']):
                raise ArchiveError('单列观点混用了不同发言者的引用，已阻止发布')
    return dict(outer, local_repairs=repairs), checked


def billing_metadata(raw):
    events = json.loads(raw)
    if not isinstance(events, list):
        return {}
    rows = []
    for event in events:
        if event.get('role') != 'assistant':
            continue
        provider = event.get('providerData', {})
        usage = provider.get('rawUsage', {})
        if usage:
            rows.append({'request_id': provider.get('conversationRequestId'),
                         'model': provider.get('model'), 'usage': usage})
    result = {'provider_usage': rows}
    if rows and all(isinstance(row['usage'].get('credit'), (int, float)) for row in rows):
        result.update(credits=round(sum(row['usage']['credit'] for row in rows), 6),
                      credit_source='official_provider_rawUsage.credit')
    return result


def check_effort(model, effort):
    product = json.loads((RUNTIME / 'buddy-runtime/node_modules/@tencent-ai/codebuddy-code/product.internal.json').read_text(encoding='utf-8'))
    item = next((m for m in product['models'] if m.get('id') == model), None)
    reasoning = (item or {}).get('reasoning', {})
    supported = reasoning.get('supportedEfforts', [])
    # Some official models declare only their default effort. Permit that exact
    # default; do not infer other levels or let the CLI silently clamp them.
    if not supported and reasoning.get('effort'):
        supported = [reasoning['effort']]
    if not supported or effort not in supported:
        raise ArchiveError(f'{model} 不支持已确认的 {effort} 思考档位，已在调用前停止；可用档位：' + '、'.join(supported))


def run(day, model='hy4-preview', data_dir=None, effort='high', variant=None):
    data_dir = Path(data_dir) if data_dir is not None else data_root().resolve()
    cache = data_dir / 'cache'
    cache.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='summary-images-',dir=cache) as temporary:
        return _run(day,model,data_dir,effort,variant,temporary)


def _run(day, model, data_dir, effort, variant, temporary):
    routes = input_routes(model)
    data_dir = Path(data_dir) if data_dir is not None else data_root().resolve()
    prepared = prepare_day(data_dir, day)
    require_summary_resources(prepared, allow_missing=True)
    gaps = missing_resources(prepared)
    images = summary_images(data_dir, prepared, temporary_dir=temporary, skipped=gaps)
    if not prepared['summarizable'] or not prepared['messages']:
        raise ArchiveError('归档存在缺口或没有聊天，请先补充读取')
    if effort not in ('minimal', 'low', 'medium', 'high', 'xhigh', 'max'):
        raise ArchiveError('思考强度无效')
    if variant is not None and not re.fullmatch(r'[a-z0-9-]{1,60}', variant):
        raise ArchiveError('总结版本名称无效')
    destination = data_dir / 'summaries' / (day + '.json') if variant is None else data_dir / 'summary-variants' / day / (variant + '.json')
    if destination.exists():
        previous = json.loads(destination.read_text(encoding='utf-8'))
        if previous['source_hash'] == prepared['source_hash']:
            validate_summary(previous['summary'], prepared)
            return {'status': 'cached', 'date': day, 'run_id': previous['run_id'],
                    'credits': 0, 'media_credits': 0, 'summary_credits': 0}
        raise ArchiveError('当天已有总结且来源发生变化，需要明确安排更新')
    check_effort(model, effort)
    if images:
        require_input(model,'image')
        product = json.loads((RUNTIME / 'buddy-runtime/node_modules/@tencent-ai/codebuddy-code/product.internal.json').read_text(encoding='utf-8'))
        selected = next((m for m in product['models'] if m.get('id') == model), {})
        if not selected.get('supportsImages') or selected.get('disabledMultimodal'):
            raise ArchiveError('所选模型不支持图片，已在调用前停止')
    runs = data_dir / 'summary-runs'
    runs.mkdir(exist_ok=True)
    lock = runs / (day + '.lock')
    # 锁在失败时保留，阻止不知情的重复计费。
    try:
        with lock.open('x', encoding='utf-8') as f:
            f.write(datetime.now(timezone.utc).isoformat())
    except FileExistsError:
        raise ArchiveError('该日期已有执行或待核实的失败记录，未再次调用') from None
    run_id = datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:8]
    folder = runs / run_id
    folder.mkdir()
    record = {'run_id': run_id, 'date': day, 'model_requested': model, 'effort_requested': effort, 'variant': variant,
              'source_hash': prepared['source_hash'], 'message_count': prepared['message_count'],
              'started_at': datetime.now(timezone.utc).isoformat(), 'status': 'running',
              'credits': None, 'credit_source': 'pending_official_usage', 'cli_version': '2.172.1',
              'editorial_contract': 'discussion-briefs-v4',
              'partial': prepared['partial'], 'coverage_end': prepared['coverage_end'],
              'missing_resources': gaps, 'resource_coverage': prepared.get('resource_coverage', {})}
    save(folder / 'receipt.json', record)
    record['input_routes'] = routes
    record.update(media_attempts=[], media_credits=0, summary_credits=0, media_models=[])
    started = time.monotonic()
    stage = 'prepare'
    try:
        # User-selected scope is now text and images. Never execute a video
        # or audio model here, even if older inventories contain media blobs.
        media_attempts = []
        record['media_attempts'] = media_attempts
        record['media_credits'] = media_credits(media_attempts)
        require_summary_resources(prepared, allow_missing=True)
        save(folder / 'receipt.json',record)
        messages, reference_map = compact_model_messages(prepared)
        save(folder / 'reference-map.json', {'source_hash': prepared['source_hash'], 'references': reference_map})
        payload = json.dumps({'task': '微信群单日总结验证 ' + day,
                              'date': day, 'timezone': 'Asia/Shanghai',
                              'coverage': {'full_day': prepared['complete'], 'end_exclusive': prepared['coverage_end'],
                                           'missing_resources': [dict(gap, message=next(k for k,v in reference_map.items() if v == gap['message'])) for gap in gaps],
                                           'instruction': '仅总结输入覆盖的时段；未结束的一天不能描述成全天结论。'},
                              'messages': messages}, ensure_ascii=False)
        record['input_sha256'] = hashlib.sha256(payload.encode('utf-8')).hexdigest()
        prompt_bytes = (ROOT / 'summary-prompt.txt').read_bytes()
        record['prompt_sha256'] = hashlib.sha256(prompt_bytes).hexdigest()
        (folder / 'system-prompt.txt').write_bytes(prompt_bytes)
        cli = RUNTIME / 'buddy-runtime/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy'
        args = ['node', str(cli), '-p', '--output-format', 'json', '--model', model, '--effort', effort,
                '--tools', '', '--strict-mcp-config', '--setting-sources', '',
                '--no-session-persistence', '--permission-mode', 'dontAsk',
                '--max-turns', '1', '--system-prompt-file', str(folder / 'system-prompt.txt')]
        image_manifest = None
        if images:
            inverse = {value: key for key, value in reference_map.items()}
            image_manifest = {'model': model, 'auditPath': str(folder / 'image-wire.jsonl'), 'images': []}
            for source_id, asset, path in images:
                marker = 'OBSERVE_IMAGE_' + uuid.uuid4().hex
                payload += '\n以下完整图片属于消息 ' + inverse[source_id] + '：\n' + marker + '\n'
                if asset.get('frame_count'):
                    payload += f"动图顺序：第 {asset['frame_index']}/{asset['frame_count']} 帧，持续 {asset['duration_ms']} 毫秒。\n"
                if asset.get('tile_count'):
                    payload += f"同一完整图片的无损分段 {asset['tile_index']}/{asset['tile_count']}，原图尺寸 {asset['source_size']}，像素区域 {asset['tile_box']}。按原图位置连贯阅读，所有分段合起来覆盖全部原图。\n"
                image_manifest['images'].append({'marker': marker, 'sha256': asset['id'],
                                                 'path': str(path), 'mime': asset['mime']})
            save(folder / 'image-manifest.json', image_manifest)
            args[1:1] = ['--require', str(ROOT.parents[1] / 'scripts' / 'codebuddy-image-wire.cjs')]
            record['input_sha256'] = hashlib.sha256(payload.encode('utf-8')).hexdigest()
            record['images'] = [dict(message=source_id, sha256=asset['id'], bytes=asset['bytes'],
                                     **{key:asset[key] for key in ('source_id','frame_index','frame_count','duration_ms','tile_index','tile_count','tile_box','source_size') if key in asset})
                                for source_id, asset, _ in images]
        env = dict(os.environ)
        for key in list(env):
            if key.startswith(('CODEBUDDY_API_', 'ANTHROPIC_', 'OPENAI_')) or key in ('CODEBUDDY_BASE_URL', 'CODEBUDDY_MODEL'):
                del env[key]
        env['CODEBUDDY_INTERNET_ENVIRONMENT'] = 'internal'
        if image_manifest:
            env['OBSERVE_BUDDY_IMAGE_MANIFEST'] = str(folder / 'image-manifest.json')
        working = data_dir / 'buddy-jobs'
        working.mkdir(exist_ok=True)
        stage = 'execute'
        record['summary_credits'] = None
        with (folder / 'stdout.json').open('wb') as out, (folder / 'stderr.txt').open('wb') as err:
            process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=out, stderr=err,
                                       cwd=working, env=env, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            record['pid'] = process.pid
            save(folder / 'receipt.json', record)
            try:
                process.communicate(payload.encode('utf-8'), timeout=600)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                raise ArchiveError('CLI 超时，已停止该次执行；消耗待核实，不自动重试') from None
        record['exit_code'] = process.returncode
        stage = 'read_result'
        raw = (folder / 'stdout.json').read_text(encoding='utf-8-sig')
        # 即使内容校验失败，也保留实际用量。
        try:
            outer = result_record(raw)
            record.update(billing_metadata(raw))
            record['summary_credits'] = record.get('credits')
            if record.get('media_attempts'):
                record['credits'] = (round(record['summary_credits'] + record['media_credits'],6)
                                     if record['summary_credits'] is not None and record['media_credits'] is not None else None)
            for key in ('usage', 'modelUsage', 'duration_ms', 'duration_api_ms', 'num_turns', 'session_id', 'subtype', 'is_error'):
                if key in outer:
                    record[key] = outer[key]
        except (ArchiveError, ValueError, TypeError):
            pass
        if process.returncode:
            raise ArchiveError(f'CLI 执行失败（退出码 {process.returncode}），已保留执行记录与用量')
        if image_manifest:
            audit_file = folder / 'image-wire.jsonl'
            events = [json.loads(line) for line in audit_file.read_text(encoding='utf-8').splitlines()] if audit_file.exists() else []
            requests = [event for event in events if event.get('type') == 'image_request']
            responses = [event for event in events if event.get('type') == 'image_response']
            if responses:
                record['image_http_status'] = responses[-1]['status']
                if not 200 <= responses[-1]['status'] < 300:
                    raise ArchiveError(f"图片请求被服务拒绝（HTTP {responses[-1]['status']}），未生成总结")
            if len(requests) != 1 or len(requests[0]['images']) != len(images) or not any(200 <= event['status'] < 300 for event in responses):
                raise ArchiveError('未核实全部图片实际提交并被服务接收，已保留回执，不发布总结')
            record['image_count_submitted'] = len(images)
        stage = 'validate'
        parsed, summary = parse_result(raw, prepared, reference_map)
        record['local_repairs'] = parsed['local_repairs']
        if summary.get('format_version') != 4:
            raise ArchiveError('模型未遵守讨论分段规范 v4，已保留回执，不自动重试')
        stage = 'save'
        save(destination, {'date': day, 'source_hash': prepared['source_hash'],
                           'run_id': run_id, 'summary': summary,
                           'partial': prepared['partial'], 'coverage_end': prepared['coverage_end'],
                           'missing_resources': gaps, 'resource_coverage': prepared.get('resource_coverage', {})})
        record['status'] = 'complete'
        record['topic_count'] = len(summary['topics'])
        lock.unlink()
    except Exception as error:
        if isinstance(error, MediaFailure):
            record['media_attempts'] = error.records
            record['media_credits'] = media_credits(error.records)
            stage = 'media'
        record['status'] = 'failed'
        record['error_type'] = type(error).__name__
        record['error_stage'] = stage
        if isinstance(error, ArchiveError):
            reason = str(error)
        else:
            reason = {'prepare': '总结输入准备失败，已保留已有媒体用量',
                      'media': '媒体读取失败，已保留用量', 'execute': '总结进程无法完成执行，请检查本机运行环境',
                      'read_result': '总结执行记录无法读取，请检查本机文件',
                      'validate': '总结结果结构异常，无法完成校验',
                      'save': '总结结果保存失败，请检查目录权限与磁盘空间'}[stage]
            reason += f'（{type(error).__name__}）'
        record['error'] = reason
        # Only controlled explanations reach the UI, never raw CLI output,
        # exception text, chat content, credentials or filesystem paths.
        raise SummaryFailure(reason, record) from None
    finally:
        record['media_models'] = list(dict.fromkeys(a['model'] for a in record['media_attempts']))
        record['credits'] = media_credits([{'credits':record.get(key)} for key in ('media_credits','summary_credits')])
        record['known_credits'] = round(sum(record.get(key) or 0 for key in ('media_credits','summary_credits')),6)
        record['credits_pending'] = record['credits'] is None
        record['elapsed_seconds'] = round(time.monotonic() - started, 2)
        record['finished_at'] = datetime.now(timezone.utc).isoformat()
        save(folder / 'receipt.json', record)
    return record


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--date', required=True)
    parser.add_argument('--model', default='hy4-preview')
    parser.add_argument('--effort', choices=['minimal','low','medium','high','xhigh','max'], default='high')
    parser.add_argument('--variant')
    args = parser.parse_args()
    try:
        print(json.dumps(run(args.date, args.model, effort=args.effort, variant=args.variant), ensure_ascii=False))
    except ArchiveError as error:
        print(str(error))
        raise SystemExit(1)
