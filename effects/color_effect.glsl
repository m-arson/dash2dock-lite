uniform float red;
uniform float green;
uniform float blue;
uniform float blend;

vec4 d2da_effect(vec4 c) {
    return vec4(red * c.a * blend, green * c.a * blend, blue * c.a * blend, c.a * blend);
}