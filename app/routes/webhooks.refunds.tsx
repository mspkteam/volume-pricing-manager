import type { ActionFunctionArgs } from "react-router";
import { action as ordersAction } from "./webhooks.orders";

export const action = async (args: ActionFunctionArgs) => ordersAction(args);
