import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private supabaseService: SupabaseService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET'),
    });
  }

  async validate(payload: { sub: string; email: string }) {
    const { data, error } = await this.supabaseService.client
      .from('sessions')
      .select('*')
      .eq('user_id', payload.sub)
      .single();

    if (error || !data) {
      throw new UnauthorizedException('Session tidak ditemukan, silakan login ulang');
    }

    return { userId: payload.sub, email: payload.email };
  }
}