const express = require('express');
const cors = require('cors');
const Replicate = require('replicate');
const dotenv = require('dotenv');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const mongoose = require('mongoose');
const multer = require('multer');
const sharp = require('sharp');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

dotenv.config();

const app = express();

// Configure multer for memory storage
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
}).fields([
    { name: 'image', maxCount: 1 },
    { name: 'mask', maxCount: 1 }
]);

// Middleware setup
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Initialize clients
const replicate = new Replicate({
    auth: process.env.REPLICATE_API_TOKEN,
});

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

// gallery schema
const gallerySchema = new mongoose.Schema({
    prompt: { type: String, required: true },
    imageUrl: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    dimensions: {
        width: Number,
        length: Number,
        height: Number
    },
    originalImage: String,
    maskImage: String
});

const Gallery = mongoose.model('Gallery', gallerySchema);

// Utility function to upload to S3
async function uploadToS3(buffer, filename, contentType = 'image/jpeg') {
    const s3Key = `genai-images/${Date.now()}_${filename}`;
    const uploadParams = {
        Bucket: process.env.AWS_S3_BUCKET_NAME,
        Key: s3Key,
        Body: buffer,
        ContentType: contentType,
    };

    await s3Client.send(new PutObjectCommand(uploadParams));
    return `https://${process.env.AWS_S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Key}`;
}

// GENERATE IMAGE ENDPOINT
app.post('/api/generate', upload, async (req, res) => {
    try {
        const {
            prompt,
            dimensions
        } = req.body;


        let originalImage = null;
        let maskImage = null;
        let isPromptOnly = null;


        // Check if this is Option 1 (image upload) or Option 2 (prompt only)
        if (req.files) {
            console.log("yes the user uploaded files");
            originalImage = req.files['image']?.[0];
            maskImage = req.files['mask']?.[0];
        } else {
            isPromptOnly = true;
        }


        // For EDIT IMAGE MODE, ensure an image is provided
        if (!isPromptOnly && !originalImage) {
            return res.status(400).json({ error: 'No image provided for image-based generation' });
        }

        // Process dimensions for the prompt
        const dimensionsObj = dimensions ? JSON.parse(dimensions) : null;
        const dimensionsPrompt = dimensionsObj ?
            `in a ${dimensionsObj.width}meters wide by ${dimensionsObj.length}meters long by ${dimensionsObj.height}meters high room` : '';

        // Enhanced prompt engineering
        const enhancedPrompt = `
            HIGH PRIORITY INSTRUCTIONS: ((${prompt})), blended transition with the existing structure, INTR, Style reference: modern contemporary architecture, high-end interior design, ${dimensionsObj ? dimensionsPrompt : "."}`.trim();

        console.log(enhancedPrompt);

        // Prepare model input with optimized parameters
        const modelInput = {
            prompt: enhancedPrompt,
            negative_prompt: "bad quality, low quality, blurry, distorted proportions, inconsistent style, mismatched textures",
            num_inference_steps: 50, // Increased for better quality
            guidance_scale: 10, // Increased for better prompt adherence
            prompt_strength: 1,
            denoising_strength: 0.75, // Added to allow more dramatic changes
            scheduler: "DPMSolverMultistep", // Added scheduler for better results
            num_outputs: 1,
            aspect_ratio: "16:9",
            lora_scale: 0.7,
            output_format: "jpg",
            controlnet_conditioning_scale: 0.5,  // Increased for better structural control
            controlnet_type: "depth",
        };

        // If EDIT IMAGE MODE, process and upload the original image and mask
        let originalImageUrl = null;
        let maskImageUrl = null;

        if (!isPromptOnly) {
            // Process and upload original image
            const processedBuffer = await sharp(originalImage.buffer)
                .resize(1024, 1024, {
                    fit: 'inside',
                    withoutEnlargement: true
                })
                .toBuffer();

            originalImageUrl = await uploadToS3(
                processedBuffer,
                `original_${originalImage.originalname}`
            );

            modelInput.image = originalImageUrl;

            // Process and upload mask if present
            if (maskImage) {
                // Ensure mask is properly processed as binary
                const processedMask = await sharp(maskImage.buffer)
                    .resize(1024, 1024, {
                        fit: 'inside',
                        withoutEnlargement: true
                    })
                    .threshold(128)
                    .blur(13) // Apply slight blur for soft transition
                    .toBuffer();

                maskImageUrl = await uploadToS3(
                    processedMask.buffer,
                    `mask_${Date.now()}.png`,
                    'image/png'
                );
                modelInput.mask = maskImageUrl;
            }


        } else {
            // For NEW DESIGN MODE (prompt-only), ensure no image or mask is included in the model input
            delete modelInput.image;
            delete modelInput.mask;
            delete modelInput.controlnet_conditioning_scale;
            delete modelInput.controlnet_type;
        }

        // Generate image
        const output = await replicate.run(
            "rihan-a/colourful_interiors:ba0425bc2e4bebafa8bd918519fdf3b5a022969a6a7c8ba0746b807bb5b541a3",
            { input: modelInput }
        );

        if (!output || !output[0] || typeof output[0] !== 'string') {
            throw new Error('Invalid output format from Replicate API');
        }

        // Fetch and store the generated image
        const imageResponse = await fetch(output[0]);
        if (!imageResponse.ok) {
            throw new Error('Failed to fetch image from Replicate API');
        }

        const arrayBuffer = await imageResponse.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // Upload generated image to S3
        const s3ImageUrl = await uploadToS3(
            buffer,
            `generated_${Date.now()}.jpg`
        );

        // Save to gallery
        const newGalleryItem = new Gallery({
            prompt,
            imageUrl: s3ImageUrl,
            dimensions,
            originalImage: originalImageUrl, // Will be null for Option 2
            maskImage: maskImageUrl // Will be null for Option 2
        });
        await newGalleryItem.save();

        res.json({
            outputUrl: s3ImageUrl,
            originalImage: originalImageUrl, // Will be null for Option 2
            maskImage: maskImageUrl // Will be null for Option 2
        });

    } catch (error) {
        console.error('Error generating design:', error);
        res.status(500).json({
            error: 'Failed to generate design',
            details: error.message
        });
    }
});

// GET endpoint to fetch all gallery items
app.get('/api/gallery', async (req, res) => {
    try {
        const galleryItems = await Gallery.find().sort({ createdAt: -1 });
        res.status(200).json(galleryItems);
    } catch (error) {
        console.error('Error fetching gallery items:', error);
        res.status(500).json({
            error: 'Failed to fetch gallery items',
            details: error.message
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});




