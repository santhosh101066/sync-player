import { Request, ResponseToolkit } from "@hapi/hapi";

export const checkAdminEmailHandler = async (request: Request, h: ResponseToolkit) => {
    const { email } = request.query;
    const adminEmail = process.env.ADMIN_EMAIL;

    if (!adminEmail) {
        return h.response({ isAdmin: false, error: "Admin email not configured" }).code(200);
    }

    const isAdmin = email === adminEmail;
    return h.response({ isAdmin }).code(200);
};
