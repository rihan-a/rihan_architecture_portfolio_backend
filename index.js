// index.js
const express = require('express');
const cors = require('cors');
const Replicate = require('replicate');
const dotenv = require('dotenv');
const fetch = require('node-fetch');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

dotenv.config();

const app = express();

// Middleware setup
app.use(cors());
app.use(express.json());

// Initialize Replicate client
const replicate = new Replicate({
    auth: process.env.REPLICATE_API_TOKEN,
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

// Initialize S3 client
const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

// POST endpoint to generate images
app.post('/api/generate', async (req, res) => {
    const { prompt } = req.body;

    try {
        const output = await replicate.run(
            "rihan-a/colourful_interiors:ba0425bc2e4bebafa8bd918519fdf3b5a022969a6a7c8ba0746b807bb5b541a3",
            {
                input: {
                    aspect_ratio: "16:9",
                    prompt,
                    output_format: "jpg",
                },
            }
        );

        // Here we assume the first item in output is the image URL or data
        if (output && output[0]) {
            if (typeof output[0] === 'string') {
                // If the output is a URL, send it directly
                res.json({ outputUrl: output[0] });
            } else if (output[0] instanceof ReadableStream) {
                // Convert the ReadableStream to a Buffer
                const buffer = await streamToBuffer(output[0]);
                const base64Image = buffer.toString('base64');
                res.json({ outputUrl: `data:image/jpeg;base64,${base64Image}` });
            } else {
                throw new Error('Unexpected output format from Replicate API');
            }
        } else {
            throw new Error('No output received from Replicate API');
        }
    } catch (error) {
        console.error('Error generating design:', error);
        res.status(500).json({ error: 'Failed to generate design', details: error.message });
    }
});

// Helper function to convert stream to buffer
async function streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});