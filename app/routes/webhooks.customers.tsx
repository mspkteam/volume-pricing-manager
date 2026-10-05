import type { ActionFunctionArgs } from "react-router";
import { action as ordersAction } from "./webhooks.orders";

/** Shared durable webhook handler for customer topics */
export const action = async (args: ActionFunctionArgs) => ordersAction(args);
