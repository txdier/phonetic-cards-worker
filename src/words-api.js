import { jsonResponse } from './http.js';
import { normalizeTerm } from '../public/lib/text.js';

export async function handleWordsApi(request, env, path, userId) {
  const method = request.method;

  if (path === '/api/words' && method === 'GET') {
    const { results: words } = await env.DB.prepare(
      'SELECT * FROM words WHERE user_id = ? ORDER BY created_at DESC'
    ).bind(userId).all();
    const { results: forms } = await env.DB.prepare(
      'SELECT word_id, form, normalized_form FROM word_forms WHERE user_id = ? ORDER BY created_at'
    ).bind(userId).all();
    const formsByWord = new Map();
    for (const form of forms) {
      const wordForms = formsByWord.get(form.word_id) || [];
      wordForms.push({ form: form.form, normalized_form: form.normalized_form });
      formsByWord.set(form.word_id, wordForms);
    }
    return jsonResponse(words.map(word => ({
      ...word,
      lemma: word.lemma || word.en,
      forms: formsByWord.get(word.id) || []
    })));
  }

  if (path === '/api/words' && method === 'POST') {
    const body = await request.json();
    if (!body.en || !body.zh) {
      return jsonResponse({ error: 'en and zh are required' }, { status: 400 });
    }
    const id = crypto.randomUUID();
    const formId = crypto.randomUUID();
    const createdAt = Date.now();
    const submittedEn = body.en.trim();
    const lemma = normalizeTerm(body.lemma || body.en);
    const normalizedForm = normalizeTerm(submittedEn);
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO words (id, user_id, en, lemma, zh, example, stress, familiarity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)'
      ).bind(
        id, userId, lemma, lemma, body.zh.trim(), body.example || '',
        body.stress || '', createdAt
      ),
      env.DB.prepare(
        'INSERT INTO word_forms (id, word_id, user_id, form, normalized_form, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(formId, id, userId, submittedEn, normalizedForm, createdAt)
    ]);
    return jsonResponse({
      id, en: lemma, lemma, zh: body.zh.trim(),
      example: body.example || '', stress: body.stress || '',
      familiarity: 0, last_tested_at: null, created_at: createdAt,
      forms: [{ form: submittedEn, normalized_form: normalizedForm }]
    }, { status: 201 });
  }

  const wordMatch = path.match(/^\/api\/words\/([a-zA-Z0-9-]+)$/);

  if (wordMatch && method === 'PATCH') {
    const id = wordMatch[1];
    const body = await request.json();
    if (typeof body?.familiarity === 'number') {
      const lastTestedAt = Date.now();
      await env.DB.prepare(
        'UPDATE words SET familiarity = ?, last_tested_at = ? WHERE id = ? AND user_id = ?'
      ).bind(body.familiarity, lastTestedAt, id, userId).run();
      return jsonResponse({ ok: true, last_tested_at: lastTestedAt });
    }

    const validEdit = body && typeof body === 'object'
      && typeof body.lemma === 'string' && normalizeTerm(body.lemma)
      && typeof body.zh === 'string' && body.zh.trim()
      && typeof body.example === 'string'
      && typeof body.stress === 'string';
    if (!validEdit) {
      return jsonResponse({ error: 'lemma and zh are required', code: 'WORD_REQUIRED_FIELDS' }, { status: 400 });
    }
    const lemma = normalizeTerm(body.lemma);
    const zh = body.zh.trim();
    const example = body.example;
    const stress = body.stress.trim();
    await env.DB.prepare(
      'UPDATE words SET en = ?, lemma = ?, zh = ?, example = ?, stress = ? WHERE id = ? AND user_id = ?'
    ).bind(lemma, lemma, zh, example, stress, id, userId).run();
    return jsonResponse({ id, en: lemma, lemma, zh, example, stress });
  }

  if (wordMatch && method === 'DELETE') {
    const id = wordMatch[1];
    await env.DB.prepare(
      'DELETE FROM words WHERE id = ? AND user_id = ?'
    ).bind(id, userId).run();
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: 'not found' }, { status: 404 });
}
