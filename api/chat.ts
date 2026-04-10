import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    // 1. Прямая проверка метода
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // 2. Получение данных из секретных переменных Vercel
    const GROQ_API_KEY = process.env.GROQ_API_KEY;

    if (!GROQ_API_KEY) {
        return res.status(500).json({ error: 'Backend configuration error: API Key missing.' });
    }

    try {
        const { messages, model, temperature, max_tokens } = req.body;

        // 3. Запрос к Groq
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messages,
                model: model || 'llama-3.3-70b-versatile',
                temperature: temperature || 0.1,
                max_tokens: max_tokens || 1024,
            }),
        });

        const data = await response.json();

        // 4. Возврат ответа плагину
        return res.status(response.status).json(data);

    } catch (error) {
        console.error('[Lume Proxy Error]:', error);
        return res.status(500).json({ error: 'Internal Server Error during AI call.' });
    }
}
