import { Request, ResponseToolkit } from "@hapi/hapi";
import fs from "fs";
import path from "path";
import { Readable } from "stream";

export const uploadHandler = async (request: Request, h: ResponseToolkit) => {
    try {
        const data = request.payload as any;
        if (!data || !data.file) {
            return h.response({ error: "No file uploaded" }).code(400);
        }

        const file = data.file;
        const uploadDir = path.join(process.cwd(), 'uploads');

        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }

        const filename = `${Date.now()}-${file.hapi.filename}`;
        const filePath = path.join(uploadDir, filename);

        const fileStream = fs.createWriteStream(filePath);

        await new Promise((resolve, reject) => {
            file.pipe(fileStream);
            file.on('end', resolve);
            file.on('error', reject);
        });

        return { url: `/uploads/${filename}` };
    } catch (err) {
        console.error("Upload error:", err);
        return h.response({ error: "Internal Server Error" }).code(500);
    }
};
