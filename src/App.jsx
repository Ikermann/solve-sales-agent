import React, { useState, useEffect, useRef } from 'react';

// Environment variables and configuration
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
const hasApiKey = !!apiKey;

// --- Constants ---
const COACH_ROLE_NAME = "Sales Coach";

// --- SOLVE Core Structure (Used in config screen and progress panel) ---
const SOLVE_STEPS_DATA = [
    { key: 'S', label: 'Spot the Pain', long: 'Identify and confirm a specific, quantifiable pain point. (e.g., "So, that waste of time costs you about $3,000 a month, correct?")' },
    { key: 'O', label: 'Outline Outcome', long: 'Clearly state the guaranteed, quantifiable positive result. (e.g., "We guarantee you\'ll save 15 hours a week, freeing you up for $5k in new client revenue.")' },
    { key: 'L', label: 'Limit Risk', long: 'Present a strong, risk-free guarantee or condition (e.g., money-back, pay-on-performance, or clear SLA).' },
    { key: 'V', label: 'Value Pack', long: 'Create urgency or add extra value. (e.g., "The first 10 clients this month get the advanced setup training free, but spots close Friday.")' },
    { key: 'E', label: 'Execute CTA', long: 'Ask for a clear, definitive next step. (e.g., "Does it make sense to book a 15-minute onboarding call right now?")' },
];

// --- Simplified Initial Prompt (Used in the first chat message) ---
const COACH_GUIDE_TEXT = `
## Welcome to the SOLVE Confidence Challenge!

**Your goal:** Guide the prospect through the 5-step SOLVE framework using conversational, objection-handling language. Your progress is tracked in the panel on the right. To review the framework steps, click the "What is SOLVE?" button on the Start Roleplay screen.
`;

// --- Firebase Dummy Setup (Mandatory Standard) ---
let auth = null;
let db = null;
const dummyUserId = crypto.randomUUID(); 

// --- JSON Response Schema Definition ---
const RESPONSE_SCHEMA = {
    type: "OBJECT",
    properties: {
        response_text: {
            type: "STRING",
            description: "The prospect's chat message, including any objections or questions."
        },
        solve_status: {
            type: "OBJECT",
            description: "A boolean map showing which steps of the SOLVE framework the user has successfully completed in the conversation so far.",
            properties: {
                "S": { type: "BOOLEAN", description: "Spot the Pain Point: True if the user has confirmed a specific, quantifiable pain point." },
                "O": { type: "BOOLEAN", description: "Outline a Specific Outcome: True if the user has clearly stated the quantifiable, positive result." },
                "L": { type: "BOOLEAN", description: "Limit Risk with Guarantees: True if the user has presented a strong, risk-free guarantee." },
                "V": { type: "BOOLEAN", description: "Value Pack with Urgency: True if the user has added extra value or created a time-sensitive incentive." },
                "E": { type: "BOOLEAN", description: "Execute with a Clear Call to Action: True if the user has explicitly requested the next step." }
            },
            propertyOrdering: ["S", "O", "L", "V", "E"]
        }
    },
    propertyOrdering: ["response_text", "solve_status"]
};

const callClaude = async (history, systemInstruction, isFinalCall = false) => {
    const apiKey = import.meta.env.VITE_CLAUDE_API_KEY;
    if (!apiKey) {
        throw new Error('Claude API key is not configured. Please set VITE_CLAUDE_API_KEY in your .env file.');
    }

    const model = 'claude-3-opus-20240229';
    const maxRetries = 3;
    const baseDelay = 1000;
    let lastError = null;

    try {
        const apiUrl = 'https://api.anthropic.com/v1/messages';
        
        // Convert history to Claude's message format
        const messages = history.map(msg => ({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.parts[0].text
        }));

        if (systemInstruction) {
            messages.unshift({
                role: 'system',
                content: systemInstruction
            });
        }

        const payload = {
            model,
            messages,
            max_tokens: 1024,
            temperature: 0.7,
            system: "You are a sales coach helping with the SOLVE framework. Your responses should be in JSON format matching the specified schema."
        };

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'x-api-key': apiKey,
                        'anthropic-version': '2023-06-01'
                    },
                    body: JSON.stringify(payload)
                });

                // Handle rate limiting
                if (response.status === 429) {
                    const retryAfter = response.headers.get('Retry-After');
                    const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : baseDelay * Math.pow(2, attempt);
                    console.warn(`Rate limit reached (attempt ${attempt + 1}/${maxRetries}), waiting ${waitTime/1000} seconds...`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    continue;
                }

                // Handle successful response
                if (response.ok) {
                    const responseText = await response.text();
                    const result = JSON.parse(responseText);

                    if (isFinalCall) {
                        return { 
                            text: result.text, 
                            status: { S: true, O: true, L: true, V: true, E: true } 
                        };
                    }

                    const parsed = JSON.parse(result.text.replace(/```json\n?|```/g, '').trim());
                    return {
                        text: parsed.response_text,
                        status: {
                            S: !!parsed.solve_status?.S,
                            O: !!parsed.solve_status?.O,
                            L: !!parsed.solve_status?.L,
                            V: !!parsed.solve_status?.V,
                            E: !!parsed.solve_status?.E,
                        }
                    };
                }

                // Handle other errors
                const errorBody = await response.text();
                lastError = new Error(`API Error (${response.status}): ${errorBody}`);
                
                if (response.status === 503 || attempt === maxRetries - 1) {
                    break;
                }

                const waitTime = baseDelay * Math.pow(2, attempt);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            } catch (error) {
                lastError = error;
                if (attempt === maxRetries - 1) break;

                const waitTime = baseDelay * Math.pow(2, attempt);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }

        throw lastError || new Error("Failed to get a response from the model.");
    } catch (error) {
        throw error;
    }
};

// Helper to generate initial message based on persona and industry
const generateInitialMessage = (persona, industry) => {
    const personas = {
        'Skeptical, Budget-Conscious': {
            name: 'Alex Thompson',
            opening: "Look, I appreciate you reaching out, but I've been burned by 'miracle solutions' before. Our budget is tight, and I need to see real numbers before even considering any changes.",
        },
        'Friendly, Time-Pressed': {
            name: 'Sam Rivera',
            opening: "Thanks for connecting! I'm honestly swamped right now, but I'm curious about what you're offering. Just need to make sure it's worth the time investment.",
        },
        'Overwhelmed, Needs Hand-Holding': {
            name: 'Jordan Chen',
            opening: "There's just so much to consider, and I'm not sure where to start. We definitely need help, but I'm worried about making the wrong choice.",
        },
        'Analyst, Data-Focused': {
            name: 'Dr. Morgan Lee',
            opening: "I've reviewed several solutions in this space. What specific metrics can you show me that demonstrate your solution's effectiveness compared to the alternatives?",
        },
        'Innovator, Excited but Distracted': {
            name: 'Taylor Kim',
            opening: "Your solution looks fascinating! We're actually in the middle of several other initiatives though. Help me understand why this should be a priority now.",
        }
    };

    const personaInfo = personas[persona];
    return `${personaInfo.name} (The Prospect):\n\n${personaInfo.opening}`;
};

// Helper to list available models
const listModels = async () => {
    if (!hasApiKey) return null;
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
        const res = await fetch(url, { method: 'GET' });
        if (!res.ok) {
            const text = await res.text();
            console.error('ListModels API error:', res.status, text);
            return null;
        }
        const json = await res.json();
        return json.models || json;
    } catch (e) {
        console.error('Failed to list models:', e);
        return null;
    }
};

// --- Modal Component for SOLVE Guide ---
const SolveGuideModal = ({ isOpen, onClose }) => {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 backdrop-blur-sm p-4">
            <div className="bg-surface rounded-xl shadow-canva-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto transform transition-all duration-300 scale-100 p-6 md:p-8 font-sans">
                <div className="flex justify-between items-center border-b border-divider pb-3 mb-4">
                    <h3 className="text-2xl font-bold text-primary">The 5-Step SOLVE Framework Guide</h3>
                    <button onClick={onClose} className="text-text-secondary hover:text-text-primary transition">
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                    </button>
                </div>
                <div className="space-y-6">
                    <p className="text-text-secondary">The SOLVE framework is a structured approach to leading sales conversations, ensuring you handle objections and move toward a concrete next step.</p>
                    {SOLVE_STEPS_DATA.map(step => (
                        <div key={step.key} className="p-4 bg-primary/5 rounded-canva border-l-4 border-primary shadow-canva">
                            <div className="flex items-center space-x-2 mb-1">
                                <div className="w-6 h-6 flex-shrink-0 flex items-center justify-center rounded-full bg-primary text-white font-bold text-sm">
                                    {step.key}
                                </div>
                                <p className="font-bold text-lg text-text-primary">{step.label}</p>
                            </div>
                            <p className="text-sm text-text-secondary">{step.long}</p>
                        </div>
                    ))}
                </div>
                <div className="mt-6 pt-4 border-t border-divider">
                    <button onClick={onClose} className="w-full py-2 bg-primary hover:bg-primary-hover text-white font-bold rounded-canva shadow-canva transition-colors duration-200">
                        Got It, Close Guide
                    </button>
                </div>
            </div>
        </div>
    );
};

// --- Start Configuration Screen ---
const StartConfig = ({ prospectConfig, setProspectConfig, onStart, setIsModalOpen }) => {
    const personas = [
        'Skeptical, Budget-Conscious',
        'Friendly, Time-Pressed',
        'Overwhelmed, Needs Hand-Holding',
        'Analyst, Data-Focused',
        'Innovator, Excited but Distracted'
    ];
    const industries = [
        'SEO Consulting (Filtering Low-Value Clients)',
        'B2B Software Sales (Streamlining Onboarding)',
        'Real Estate Brokerage (Lead Qualification)',
        'Financial Services (Compliance Automation)'
    ];

    return (
        <div className="flex flex-col items-center justify-center min-h-[80vh] p-4 bg-surface">
            <div className="bg-surface p-8 md:p-10 rounded-canva shadow-canva-lg max-w-lg w-full border border-divider">
                <h1 className="text-3xl md:text-4xl font-bold text-center text-primary mb-6">
                    SOLVE Confidence Challenge
                </h1>
                <p className="text-center text-text-secondary mb-8 text-lg">
                    Set up your sales scenario to practice handling objections and guiding the conversation to a win.
                </p>
                
                <div className="space-y-6">
                    <div>
                        <label className="block text-sm font-medium text-text-secondary mb-1">Prospect Persona</label>
                        <select
                            value={prospectConfig.persona}
                            onChange={(e) => setProspectConfig({...prospectConfig, persona: e.target.value})}
                            className="w-full p-3 border border-divider rounded-canva shadow-canva-md hover:border-primary focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none transition-colors"
                        >
                            {personas.map(p => <option key={p} value={p}>{p}</option>)}
                        </select>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-text-secondary mb-1">Industry / Challenge Focus</label>
                        <select
                            value={prospectConfig.industry}
                            onChange={(e) => setProspectConfig({...prospectConfig, industry: e.target.value})}
                            className="w-full p-3 border border-divider rounded-canva shadow-canva-md hover:border-primary focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none transition-colors"
                        >
                            {industries.map(i => <option key={i} value={i}>{i}</option>)}
                        </select>
                    </div>

                    <div className="pt-4 border-t border-divider mt-6 space-y-3">
                        <button
                            onClick={() => setIsModalOpen(true)}
                            className="w-full py-2.5 bg-surface-hover text-text-primary font-medium rounded-canva shadow-canva-md hover:bg-surface-pressed transition-colors duration-200"
                        >
                            What is SOLVE?
                        </button>
                        <button
                            onClick={onStart}
                            className="w-full py-2.5 bg-primary hover:bg-primary-hover text-white font-medium rounded-canva shadow-canva-md transition-colors duration-200"
                        >
                            Start Practice Session
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

// --- Chat Panel Component ---
const ChatPanel = ({ messages, input, setInput, isLoading, error, handleSubmit, messagesEndRef, isFinished }) => {
    return (
        <div className="flex-1 bg-surface rounded-canva shadow-canva-lg overflow-hidden border border-divider flex flex-col">
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {messages.map((message, index) => (
                    <div key={index} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[80%] rounded-canva p-3 ${
                            message.role === 'user' 
                                ? 'bg-primary text-white ml-4' 
                                : 'bg-surface-hover text-text-primary mr-4'
                        }`}>
                            {message.parts[0].text}
                        </div>
                    </div>
                ))}
                {error && (
                    <div className="bg-danger/10 border border-danger text-danger rounded-canva p-3">
                        {error}
                    </div>
                )}
                <div ref={messagesEndRef} />
            </div>
            
            <div className="p-4 border-t border-divider bg-surface">
                <form onSubmit={handleSubmit} className="flex space-x-2">
                    <input
                        type="text"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder={isFinished ? "Session complete" : "Type your response..."}
                        disabled={isFinished || isLoading}
                        className="flex-1 p-2 border border-divider rounded-canva shadow-canva-md focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                    />
                    <button
                        type="submit"
                        disabled={!input.trim() || isLoading || isFinished}
                        className="px-4 py-2 bg-primary text-white font-medium rounded-canva shadow-canva-md hover:bg-primary-hover transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {isLoading ? "..." : "Send"}
                    </button>
                </form>
            </div>
        </div>
    );
};

// --- Progress Panel Component ---
const ProgressPanel = ({ solveStatus, setIsConfiguring, processUserTurn, isLoading, isFinished }) => {
    return (
        <div className="w-full lg:w-80 bg-surface p-6 rounded-canva shadow-canva-lg overflow-y-auto font-sans h-full border border-divider">
            <h2 className="text-xl font-bold text-primary mb-4 border-b border-divider pb-2">SOLVE Progress Tracker</h2>
            <div className="space-y-4">
                {SOLVE_STEPS_DATA.map(step => {
                    const isComplete = solveStatus[step.key];
                    return (
                        <div 
                            key={step.key} 
                            className={`p-4 rounded-canva flex items-start space-x-3 transition-all duration-200 ${
                                isComplete 
                                    ? 'bg-primary/5 border-l-4 border-primary shadow-canva-md' 
                                    : 'bg-surface-hover border-l-4 border-divider'
                            }`}
                        >
                            <div className={`w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-full font-bold text-white text-lg ${
                                isComplete ? 'bg-primary' : 'bg-text-secondary'
                            }`}>
                                {step.key}
                            </div>
                            <div>
                                <p className={`font-semibold text-sm ${isComplete ? 'text-primary' : 'text-text-primary'}`}>
                                    {step.label}
                                </p>
                                <p className={`text-xs ${isComplete ? 'text-primary/80' : 'text-text-secondary'}`}>
                                    {isComplete ? 'COMPLETED' : 'Awaiting action...'}
                                </p>
                            </div>
                        </div>
                    );
                })}
            </div>
            <div className="mt-6 pt-4 border-t border-divider">
                <button
                    onClick={() => setIsConfiguring(true)}
                    className="w-full py-2 mb-2 bg-surface-hover text-text-primary font-medium rounded-canva shadow-canva-md hover:bg-surface-pressed transition-colors duration-200"
                    disabled={isLoading}
                >
                    Start New Scenario
                </button>
                <button
                    onClick={() => processUserTurn("END_CALL")}
                    className="w-full py-2 bg-danger hover:bg-danger-hover text-white font-medium rounded-canva shadow-canva-md transition-colors duration-200"
                    disabled={isFinished || isLoading}
                >
                    {isFinished ? 'CALL FINISHED' : 'Finish & Get Feedback'}
                </button>
            </div>
        </div>
    );
};

// --- App Component ---
const App = () => {
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(null);
    const [isFinished, setIsFinished] = useState(false);
    const [solveStatus, setSolveStatus] = useState({ S: false, O: false, L: false, V: false, E: false });
    const [isConfiguring, setIsConfiguring] = useState(true);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [prospectConfig, setProspectConfig] = useState({
        persona: 'Skeptical, Budget-Conscious',
        industry: 'SEO Consulting (Filtering Low-Value Clients)'
    });
    const messagesEndRef = useRef(null);

    const handleStart = () => {
        // Set initial message
        const initialText = generateInitialMessage(prospectConfig.persona, prospectConfig.industry);
        setMessages([
            { role: "coach", parts: [{ text: COACH_GUIDE_TEXT }] },
            { role: "model", parts: [{ text: initialText }] }
        ]);
        setIsConfiguring(false);
        setIsFinished(false);
        setSolveStatus({ S: false, O: false, L: false, V: false, E: false });
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!input.trim() || isLoading || isFinished) return;

        const userMessage = input.trim();
        setInput('');
        setError(null);

        const newMessages = [...messages, { role: 'user', parts: [{ text: userMessage }] }];
        setMessages(newMessages);
        setIsLoading(true);

        try {
            const response = await callClaude(newMessages);
            setMessages([...newMessages, { role: 'model', parts: [{ text: response.text }] }]);
            setSolveStatus(response.status);
        } catch (error) {
            console.error('Error:', error);
            setError(error.message);
        } finally {
            setIsLoading(false);
        }
    };

    const processUserTurn = async (action) => {
        if (action === "END_CALL") {
            setIsLoading(true);
            setError(null);
            try {
                const response = await callClaude(messages, null, true);
                setMessages([...messages, { role: 'model', parts: [{ text: response.text }] }]);
                setIsFinished(true);
            } catch (error) {
                console.error('Error:', error);
                setError(error.message);
            } finally {
                setIsLoading(false);
            }
        }
    };

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    return (
        <div className="min-h-screen bg-surface-subtle p-4 font-sans">
            {isConfiguring ? (
                <StartConfig
                    prospectConfig={prospectConfig}
                    setProspectConfig={setProspectConfig}
                    onStart={handleStart}
                    setIsModalOpen={setIsModalOpen}
                />
            ) : (
                <div className="max-w-7xl mx-auto h-[90vh] flex flex-col lg:flex-row gap-4">
                    <ChatPanel
                        messages={messages}
                        input={input}
                        setInput={setInput}
                        isLoading={isLoading}
                        error={error}
                        handleSubmit={handleSubmit}
                        messagesEndRef={messagesEndRef}
                        isFinished={isFinished}
                    />
                    <ProgressPanel
                        solveStatus={solveStatus}
                        setIsConfiguring={setIsConfiguring}
                        processUserTurn={processUserTurn}
                        isLoading={isLoading}
                        isFinished={isFinished}
                    />
                </div>
            )}
            <SolveGuideModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} />
        </div>
    );
};

export default App;