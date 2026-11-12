import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { VolumeWatchService } from './volume-watch.service';

/** Counts each GET a signed-in dashboard user makes, for the `data.unusual_reads` alarm. */
@Injectable()
export class ReadVolumeInterceptor implements NestInterceptor {
  constructor(private readonly watch: VolumeWatchService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const req = context.switchToHttp().getRequest<{ method?: string; user?: { userId?: string } }>();
      if (req.method === 'GET' && typeof req.user?.userId === 'string') this.watch.read(req.user.userId);
    }
    return next.handle();
  }
}
