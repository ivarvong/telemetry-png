import fs from 'node:fs';
import { Type } from 'typebox';
export default function (pi: any) {
  pi.registerTool({
    name: 'request_analyzed_json',
    label: 'Request analyzed JSON',
    description: 'Request the analyzed JSON for this case only when the PNG evidence is insufficient. This records the request.',
    parameters: Type.Object({ reason: Type.String() }),
    async execute(_id: string, params: {reason:string}) {
      const file=process.env.EVAL_ANALYZED_PATH;
      if(!file) throw new Error('EVAL_ANALYZED_PATH not set');
      return {content:[{type:'text',text:fs.readFileSync(file,'utf8')}],details:{requested:true,reason:params.reason}};
    }
  });
}
