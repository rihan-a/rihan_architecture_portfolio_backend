const express = require('express');
const cors = require('cors');
const Replicate = require('replicate');
const dotenv = require('dotenv');

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const mongoose = require('mongoose');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));


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

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err));


// Define a schema for gallery items
const gallerySchema = new mongoose.Schema({
    prompt: { type: String, required: true },
    imageUrl: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
});

// Create a model for gallery items
const Gallery = mongoose.model('Gallery', gallerySchema);

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

// POST endpoint to generate images
app.post('/api/generate', async (req, res) => {
    const { prompt } = req.body;
    const modifiedPrompt = `${prompt} INTR`; // Add trigger word for the AI Model

    try {
        // Call the Replicate API to generate the image
        const output = await replicate.run(
            "rihan-a/colourful_interiors:ba0425bc2e4bebafa8bd918519fdf3b5a022969a6a7c8ba0746b807bb5b541a3",
            {
                input: {
                    aspect_ratio: "16:9",
                    prompt: modifiedPrompt,
                    output_format: "jpg",
                },
            }
        );

        // Log the output for debugging
        console.log('Replicate API output:', output);

        // Ensure the output contains a valid image URL
        if (!output || !output[0] || typeof output[0] !== 'string') {
            throw new Error('Invalid output format from Replicate API');
        }

        const imageUrl = output[0]; // The generated image URL

        // Fetch the image from the URL
        const imageResponse = await fetch(imageUrl);
        if (!imageResponse.ok) {
            throw new Error('Failed to fetch image from Replicate API');
        }

        // Convert the image to a buffer
        const arrayBuffer = await imageResponse.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // Upload the image to S3
        const s3Key = `genai-images/${Date.now()}_${prompt.substring(0, 20).replace(/[^a-zA-Z0-9]/g, '_')}.jpg`; // Unique key for the image
        const uploadParams = {
            Bucket: process.env.AWS_S3_BUCKET_NAME,
            Key: s3Key,
            Body: buffer,
            ContentType: 'image/jpeg',
        };

        await s3Client.send(new PutObjectCommand(uploadParams));

        // Generate the S3 URL
        const s3ImageUrl = `https://${process.env.AWS_S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Key}`;

        // Save the prompt and S3 image URL to the gallery
        const newGalleryItem = new Gallery({ prompt, imageUrl: s3ImageUrl });
        await newGalleryItem.save();

        // Send the S3 image URL back to the client
        res.json({ outputUrl: s3ImageUrl });
    } catch (error) {
        console.error('Error generating design:', error);
        res.status(500).json({ error: 'Failed to generate design', details: error.message });
    }
});

// GET endpoint to fetch all gallery items
app.get('/api/gallery', async (req, res) => {
    try {
        const galleryItems = await Gallery.find().sort({ createdAt: -1 }); // Sort by newest first
        res.status(200).json(galleryItems);
    } catch (error) {
        console.error('Error fetching gallery items:', error);
        res.status(500).json({ error: 'Failed to fetch gallery items', details: error.message });
    }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});