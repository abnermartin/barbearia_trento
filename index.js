require('dotenv').config(); 
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');
const fs = require('fs');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const client = new Client({ 
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
});
const funcionariosAutorizados = [
    '5511930155485@c.us' 
];

// --- O NOVO CÉREBRO DO ROBÔ ---
async function interpretarMensagem(mensagemTexto) {
    const dataHoje = new Date().toLocaleDateString('pt-BR');
    
    const prompt = `
    Você é a inteligência por trás de um bot de WhatsApp para uma barbearia.
    Hoje é dia ${dataHoje}.
    Analise a mensagem do barbeiro e extraia as informações estritamente em formato JSON.
    
    A estrutura do JSON DEVE ser exatamente esta:
    {
      "acao": "agendar" (ou "consultar" ou "registrar_despesa" ou "desconhecido"),
      
      "cliente_nome": "Nome" (apenas se for agendar),
      "cliente_telefone": "Telefone" (apenas se for agendar),
      "data": "YYYY-MM-DD" (se for 'hoje', use a data de hoje),
      "horario": "HH:MM" (apenas se for agendar),
      "servico": "Corte" (ou "Barba" ou "Corte e Barba"),
      
      "despesa_descricao": "Descrição do gasto" (apenas se for registrar_despesa. Ex: "Conta de luz", "Café"),
      "despesa_valor": 150.50 (apenas se for registrar_despesa. Apenas números com ponto),
      "despesa_categoria": "Categoria" (apenas se for registrar_despesa. Ex: "Insumos", "Contas Fixas", "Geral")
    }

    Mensagem do barbeiro: "${mensagemTexto}"
    `;

    try {
        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: "Você é um assistente especialista em extrair dados e retornar APENAS em formato JSON." },
                { role: "user", content: prompt }
            ],
            model: "llama-3.3-70b-versatile",
            temperature: 0,
            response_format: { type: "json_object" }
        });

        const respostaIa = chatCompletion.choices[0]?.message?.content || "";
        return JSON.parse(respostaIa);
    } catch (erro) {
        console.error("Erro ao interpretar com Groq:", erro);
        return null;
    }
}

async function buscarIdFuncionario(telefoneWpp) {
    const numeroWppLimpo = telefoneWpp.replace(/\D/g, ''); 
    const ultimos8Wpp = numeroWppLimpo.slice(-8);

    const { data, error } = await supabase.from('profiles').select('id, full_name, phone');
    if (error || !data) return null;

    const funcionario = data.find(f => {
        const phoneBancoLimpo = (f.phone || '').replace(/\D/g, '');
        if (phoneBancoLimpo.length < 8) return false;
        
        const ultimos8Banco = phoneBancoLimpo.slice(-8);
        return ultimos8Banco === ultimos8Wpp;
    });

    return funcionario;
}

client.on('qr', (qr) => {
    console.log('📱 Escaneie o QR Code abaixo com o seu WhatsApp:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ Assistente IA da Barbearia conectado e online!');
});

client.on('message_create', async (msg) => {
    console.log(`\n[🔍 RASTREADOR] Nova mensagem detectada!`);
    console.log(`- De: ${msg.from}`);
    console.log(`- Para: ${msg.to}`);
    console.log(`- Texto: ${msg.body}`);
    console.log(`- Fui eu que enviei? (fromMe): ${msg.fromMe}`);

    const remetente = msg.from;

    // Regra 1: Se eu enviei para outra pessoa (e não é o chat "Comigo mesmo" fantasma), ignora.
    if (msg.fromMe && msg.to !== msg.from && !msg.to.includes('@lid')) {
        console.log(`[⏭️ RASTREADOR] Ignorando: Mensagem enviada para outro chat.`);
        return;
    }

    // Regra 2: O remetente está na lista de autorizados?
    if (funcionariosAutorizados.includes(remetente)) {
        console.log(`[✅ RASTREADOR] Número AUTORIZADO! Iniciando análise...`);
        
        if (msg.fromMe && msg.body.includes('🤖')) {
            console.log(`[🤖 RASTREADOR] Ignorando: Essa mensagem é a própria resposta do robô.`);
            return;
        }

        const chat = await msg.getChat();
        let textoParaAnalisar = msg.body;

        if (msg.hasMedia) {
            const media = await msg.downloadMedia();
            if (media && media.mimetype.startsWith('audio/')) {
                chat.sendStateRecording();
                try {
                    const tempFilePath = `./temp_audio_${Date.now()}.ogg`;
                    fs.writeFileSync(tempFilePath, media.data, { encoding: 'base64' });

                    const transcription = await groq.audio.transcriptions.create({
                        file: fs.createReadStream(tempFilePath),
                        model: "whisper-large-v3",
                        language: "pt",
                    });

                    textoParaAnalisar = transcription.text;
                    fs.unlinkSync(tempFilePath);
                } catch (err) {
                    msg.reply('🤖 Ops, não consegui escutar direito o seu áudio. Pode mandar de novo ou escrever?');
                    return;
                }
            } else {
                return; 
            }
        }

        if (!textoParaAnalisar || textoParaAnalisar.trim() === '') return;

        chat.sendStateTyping();

        const intencao = await interpretarMensagem(textoParaAnalisar);
        
        if (!intencao || intencao.acao === 'desconhecido') {
            msg.reply('🤖 Desculpe, não entendi. Você pode agendar horários, consultar a agenda ou registrar despesas (ex: "Gastei 50 reais de café").');
            return;
        }

        const funcionario = await buscarIdFuncionario(remetente);
        if (!funcionario) {
            msg.reply('🤖 Perfil não encontrado no aplicativo.');
            return;
        }

        // --- AÇÃO: AGENDAR ---
        if (intencao.acao === 'agendar') {
            const { error } = await supabase.from('appointments').insert({
                employee_id: funcionario.id,
                client_name: intencao.cliente_nome,
                client_phone: intencao.cliente_telefone,
                service_type: intencao.servico,
                appointment_date: intencao.data,
                time_slot: intencao.horario,
                consumables: {},
                is_finished: false
            });

            if (error) {
                msg.reply(`🤖 Erro ao salvar agendamento: ${error.message}`);
            } else {
                const dataBR = intencao.data.split('-').reverse().join('/');
                msg.reply(`🤖 Agendado, ${funcionario.full_name}! ✅\n*${intencao.cliente_nome}* dia *${dataBR}* às *${intencao.horario}*.`);
            }
        }

        // --- AÇÃO: CONSULTAR ---
        else if (intencao.acao === 'consultar') {
            const dataBusca = intencao.data || new Date().toISOString().split('T')[0];
            const dataBR = dataBusca.split('-').reverse().join('/');

            const { data: agendamentos, error } = await supabase
                .from('appointments').select('*').eq('employee_id', funcionario.id).eq('appointment_date', dataBusca).order('time_slot', { ascending: true });

            if (agendamentos.length === 0) {
                msg.reply(`🤖 Sua agenda para o dia ${dataBR} está livre!`);
            } else {
                let textoAgenda = `🤖 *Agenda de ${dataBR}:*\n\n`;
                agendamentos.forEach(ag => {
                    const status = ag.is_finished ? '(✅)' : '';
                    textoAgenda += `⏰ *${ag.time_slot}* - ${ag.client_name} - ${ag.service_type} ${status}\n`;
                });
                msg.reply(textoAgenda);
            }
        }

        // --- AÇÃO: REGISTRAR DESPESA ---
        else if (intencao.acao === 'registrar_despesa') {
            if (!intencao.despesa_descricao || !intencao.despesa_valor) {
                msg.reply('🤖 Faltaram detalhes. Diga o que comprou e o valor. Ex: "Paguei 80 reais de conta de água".');
                return;
            }

            const { error } = await supabase.from('expenses').insert({
                description: intencao.despesa_descricao,
                amount: intencao.despesa_valor,
                category: intencao.despesa_categoria || 'Geral',
                created_by: funcionario.id
            });

            if (error) {
                msg.reply(`🤖 Vixe, erro ao salvar despesa: ${error.message}`);
            } else {
                msg.reply(`🤖 Tá na mão, ${funcionario.full_name}! 💸\nDespesa com *${intencao.despesa_descricao}* no valor de *R$ ${intencao.despesa_valor}* foi registrada no financeiro.`);
            }
        }
    }
});

client.initialize();