# DSH Multimodal Bridge Protocol 1.0

## 1. Conversation contract

The DSH session log remains the only conversation source of truth. The primary
model sees one ordinary tool and conducts as many focused perception rounds as
needed. The backend's private CLI transcript is never appended to the main
context.

```jsonl
{"role":"user","content":[{"type":"text","text":"把图中能用于产品复刻的信息全部找出来"},{"type":"image","attachment":{"attachmentId":"sha256:...","mediaType":"image/png","bytes":48123,"width":1440,"height":900,"name":"ui.png"}}]}
{"role":"assistant","tool_call":{"name":"perceive_media","arguments":{"question":"建立全图清单：场景、对象、布局、文字、颜色、交互线索和不确定项","target":"exhaustive"}}}
{"role":"tool","name":"perceive_media","result":{"protocol_version":"1.0","analysis_id":"mm-call_1","round":1,"status":"needs_followup","summary":"...","coverage":[{"lane":"text_ocr","status":"missing","note":"右侧小字低清"}],"gaps":["coverage:text_ocr"],"suggested_followups":["放大并逐行读取右侧设置面板"]}}
{"role":"assistant","tool_call":{"name":"perceive_media","arguments":{"analysis_id":"mm-call_1","question":"逐行读取右侧设置面板，并标注无法确认的字符","target":"exhaustive","focus":"right settings panel"}}}
{"role":"tool","name":"perceive_media","result":{"protocol_version":"1.0","analysis_id":"mm-call_1","round":2,"status":"complete","summary":"...","boundary":{"required_lanes":["global_scene","objects_entities","spatial_relations","text_ocr","fine_detail","visual_quality","uncertainty_audit"],"satisfied":true,"reason":"..."}}}
{"role":"assistant","content":"主模型依据两轮可追溯证据组织最终答案。"}
```

The tool result is wrapped in `<dsh_multimodal_result>` in the real DSH
`tool/result` content. The wrapper makes replay parsing deterministic while the
body remains normal JSON visible to the primary model.

## 2. Completion boundary

`complete` is task-relative information saturation. It is not a claim that
every pixel has a semantic interpretation.

For `answer_query`, the host requires `task_answer`, `global_context`, and
`uncertainty_audit`. For `exhaustive`, it requires `global_scene`,
`objects_entities`, `spatial_relations`, `text_ocr`, `fine_detail`,
`visual_quality`, and `uncertainty_audit`.

The plugin, not the vision model, makes the final state transition:

1. Every required lane must be `covered` or have a non-empty explanation for
   `not_applicable`.
2. `gaps` must be empty.
3. No `critical` or `material` uncertainty may remain.
4. The backend must explicitly request `complete`.
5. At `maxRounds`, an unresolved analysis becomes `blocked`, never a false
   `complete`.

Claims carry a media index, a region/timestamp-style locator, and confidence.
Observation and inference stay separate in the backend prompt.

## 3. Durable replay state

Raw attachment references remain in the original `user/message`. Each result's
tool-private DSH presentation metadata stores `analysisId`, round, status,
backend, and immutable attachment references. That metadata is logged but not
rendered to the model. A resumed process reconstructs an unfinished analysis by
scanning `session.events`; it does not depend on an external conversation ID.

## 4. Extension vocabulary

The protocol already reserves `speech_content`, `non_speech_audio`, and
`temporal_events` coverage lanes. DSH upstream currently exposes a durable
first-class attachment path for raster images. Audio/video should be added as
attachment-store adapters plus deterministic transcription/frame sampling;
they should reuse this tool and result protocol rather than add model-visible
tools.
