import { fork } from 'child_process';
import { GenerateOptions } from '../services/interface';
import * as path from 'path';

export function generateTVM(dist: string, projPackage: any, opts: GenerateOptions) {
  return new Promise((resolve, reject) => {
    const client = fork(`${path.resolve(__dirname, 'tvm.cli')}`, [ JSON.stringify({
      dist,
      projPackage,
      opts
    }), 'keras' ]);

    client.on('message', (msg) => {
      if (msg === 1) {
        resolve({});
      } else {
        reject('Internal Error');
      }
    });
    client.on('error', reject);
  });
}
