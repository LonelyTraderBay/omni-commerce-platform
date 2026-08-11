import { All, Controller, Req, Res } from "@nestjs/common";
import { serve } from "inngest/express";

import { inngest, inngestFunctions } from "../../jobs";

const inngestHandler = serve({
  client: inngest,
  functions: inngestFunctions,
});

@Controller("api")
export class OutboxController {
  @All("inngest")
  serveInngest(@Req() request: unknown, @Res() response: unknown) {
    return inngestHandler(request, response);
  }
}
